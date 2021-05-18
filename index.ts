import * as msRestNodeAuth from "@azure/ms-rest-nodeauth";
import { ComputeManagementClient } from "@azure/arm-compute";
import {
	MongoClient,
	Database,
	Collection,
} from "mongodb";
import {
	Client as DiscordClient,
	CommandInteraction,
	Intents as DiscordIntents,
} from "discord.js";
import winston from "winston";

import BotConfig, { VMConfig } from "./lib-bot-config";
import CFG from "./config";

/**
 * The Discord permission integer required for the bot to function. See the Discord section in the README.md for details.
 */
const DISCORD_BOT_PERM = 2147483648;

/**
 * The boot server Discord slash command name.
 */
const BOOT_CMD_NAME = "boot";

const VM_POWER_STATE_DEALLOCATED = "PowerState/deallocated";
const VM_POWER_STATE_DEALLOCATING = "PowerState/deallocating";
const VM_POWER_STATE_RUNNING = "PowerState/running";
const VM_POWER_STATE_STARTING = "PowerState/starting";
const VM_POWER_STATE_STOPPED = "PowerState/stopped";
const VM_POWER_STATE_STOPPING = "PowerState/stopping";

/**
 * Data serialized about a boot in the database.
 */
interface BootData {
	/**
	 * The Discord slash command interaction which triggered the boot.
	 */
	interaction: CommandInteraction;

	/**
	 * The virtual machine configuration for the server specified by the user.
	 */
	vm_cfg: VMConfig;
}

/**
 * Represents a request to boot a virtual machine.
 * @field {Bot} bot The bot instance.
 * @field {object} data Data to serialize in database.
 */
class Boot {
	bot: Bot;
	data: BootData;
	
	/**
	 * Construct a boot request.
	 * @param {Discord Interaction} interaction The Disocrd interaction which triggered this boot.
	 * @param {object} vmCfg The configuration for a virtual machine found in the configuration file.
	 */
	constructor(bot, interaction, vmCfg) {
		this.bot = bot;
		this.data = {
			interaction,
			vm_cfg: vmCfg,
		};
	}

	/**
	 * Get the power status of the virtual machine.
	 * @returns {Promise<string|undefined>} The virtual machine PowerState status. Returns undefined if there are no power states for the virtual machine.
	 */
	async powerState() {
		// Get status of virtual machine
		const vmInstance = await this.bot.azureCompute.virtualMachines.instanceView(this.data.vm_cfg.resourceGroup, this.data.vm_cfg.azureName);
		// possible values: https://docs.microsoft.com/en-us/dotnet/api/microsoft.azure.management.compute.fluent.powerstate?view=azure-dotnet#fields
		const powerStates = vmInstance.statuses.filter((v) => v.code.indexOf("PowerState/") !== -1);
		if (powerStates.length === 0) {
			return undefined;
		}

		return powerStates[powerStates.length-1].code;
	}

	/**
	 * Save in database.
	 * @returns {Promise} Resolves when stored.
	 */
	async save() {
		await this.bot.db.boots.updateOne({ vm_cfg: this.data.vm_cfg }, this.data, { upsert: true });
	}

	/**
	 * Check the status of the virtual machine and perform the required action to boot it and update the user. Should be called at a regular interval until the virtual machine is booted.
	 */
	async poll() {
		const interaction = new CommandInteraction(this.bot.discord, this.data.interaction);
		const powerState = await this.powerState();
		
		switch (powerState) {
			case VM_POWER_STATE_DEALLOCATED:
				interaction.reply("shut down");
				break;
			case VM_POWER_STATE_DEALLOCATING:
				interaction.reply("shutting down");
				break;
			case VM_POWER_STATE_RUNNING:
				interaction.reply("running");
				break;
			case VM_POWER_STATE_STARTING:
				interaction.reply("starting");
				break;
			case VM_POWER_STATE_STOPPED:
				interaction.reply("stopped");
				break;
			case VM_POWER_STATE_STOPPING:
				interaction.reply("stopping");
				break;
			default:
				interaction.reply("unknown");
				break;
		}
	}
}

class Bot {
	cfg: BotConfig;
	log: winston.Logger;
	azureCompute: ComputeManagementClient;
	mongoClient: MongoClient;
	mongoDB: Database;
	db: BotDB;
	discord: DiscordClient;
	
  /**
	 * Creates a partially setup Bot class. Before any other methods are run Bot.init() must be called.
	 * @param {Winston.Logger} log Parent logger.
	 */
  constructor(cfg, log) {
	  this.cfg = cfg;
		this.log = log.child({});
  }

  /**
	 * Performs initialization of Bot. Performs async operations which could not be performed in the constructor.
	 * @throws {Error} If the bot fails to initialize.
	 */
  async init() {
	  // Authenticate with the Azure API
		this.log.debug("trying to authenticate with azure");
		
	  const azureCreds = (await msRestNodeAuth.loginWithServicePrincipalSecretWithAuthResponse(this.cfg.azure.applicationID, this.cfg.azure.accessToken, this.cfg.azure.directoryID)).credentials;

	  this.azureCompute = new ComputeManagementClient(azureCreds, this.cfg.azure.subscriptionID);
		this.log.debug("authenticated with azure");

	  // Ensure all the virtual machines the user specified actually exist
	  try {
		  await Promise.all(this.cfg.vms.map(async (vm) => {
				await this.azureCompute.virtualMachines.get(vm.resourceGroup, vm.azureName);
		  }));
	  } catch (e) {
		  throw new Error(`Failed to find all virtual machines specified in the configuration: ${e}`);
	  }

	  // Connect to MongoDB
		this.log.debug("trying to connect to mongodb");
	  this.mongoClient = new MongoClient(this.cfg.mongodb.connectionURI, { useUnifiedTopology: true });
	  await this.mongoClient.connect();
		this.mongoDB = this.mongoClient.db(this.cfg.mongodb.dbName);
		this.db = {
			boots: this.mongoDB.collection("boots"),
		};
		
		this.log.debug("connected to mongodb");

		// Connect to Discord
		this.log.debug(`invite the discord bot: https://discord.com/api/oauth2/authorize?client_id=${this.cfg.discord.applicationID}&scope=bot&permissions=${DISCORD_BOT_PERM}`);
		this.log.debug("trying to connect to discord");

		this.discord = new DiscordClient({
			intents: [
				DiscordIntents.FLAGS.GUILDS,
			],
		});

		let discordReadyProm: {
			promise: Promise<void>|null,
			resolve: () => void,
			reject: () => void
		} = { promise: null, resolve: () => {}, reject: () => {} };
		discordReadyProm.promise = new Promise((resolve, reject) => {
			discordReadyProm.resolve = resolve;
			discordReadyProm.reject = reject;
		});
		this.discord.once("ready", () => {
			let cmds = this.discord.application.commands;
			if (this.cfg.discord.guildID !== null) {
				const guild = this.discord.guilds.cache.get(this.cfg.discord.guildID);

				if (guild === undefined) {
					throw new Error(`Could not find guild with ID ${this.cfg.discord.guildID}, maybe the bot doesn't have access to this guild (use the invitation link in the logs above)`);
				}

				cmds = guild.commands;
				this.log.debug(`using guild ID ${this.cfg.discord.guildID} local slash commands`);
			}
			
			cmds.create({
				name: BOOT_CMD_NAME,
				description: "Request a server be started so you can play on it",
				options: [
					{
						name: "server",
						description: "The server to start",
						type: 3, // string
						required: true,
						choices: this.cfg.vms.map((vm) => {
							return {
								name: vm.friendlyName,
								value: vm.friendlyName,
							};
						}),
					},
				],
			});

			this.log.debug("registered discord slash commands");
			discordReadyProm.resolve();
		});

		this.discord.on("interaction", this.onDiscordCmd.bind(this));
		this.discord.login(this.cfg.discord.botToken);
		await discordReadyProm.promise;
		this.log.debug("connected to discord");
  }

  /**
	 * Gracefully stop.
	 */
  async cleanup() {
	  // Disconnect from MongoDB
	  this.mongoClient.close();
  }

	/**
	 * Fetch the Discord slash commands API client. Fetches a guild specific client if the config discord.guildID field is set.
	 * @returns {Discord CommandsClient} The Discord commands client.
	 * @throws {Error} If guildID specified was not found.
	 */
	discordCommands() {
		let cmds = this.discord.application.commands;
		if (this.cfg.discord.guildID !== null) {
			const guild = this.discord.guilds.cache.get(this.cfg.discord.guildID);

			if (guild === undefined) {
				throw new Error(`Could not find guild with ID ${this.cfg.discord.guildID}, maybe the bot doesn't have access to this guild (use the invitation link in the logs above)`);
			}

			cmds = guild.commands;
		}

		return cmds;
	}

	/**
	 * Runs whenever a Discord slash command is invoked.
	 * @param {Discord Interaction} interaction Discord interaction which was just created by a user invoking a bot's slash command.
	 */
	async onDiscordCmd(interaction) {
		// Only handle slash commands
		if (interaction.isCommand() !== true) {
			return;
		}

		if (interaction.commandName === BOOT_CMD_NAME) {
			// Find parameters about vm from config
			const optName = interaction.options[0].value;

			const vmSearch = this.cfg.vms.filter((vm) => vm.friendlyName === optName);
			if (vmSearch.length !== 1) {
				throw new Error(`Could not find VM in configuration even though input was constrained by choices`);
			}

			const vmCfg = vmSearch[0];

			// Setup Boot instance
			console.trace(interaction);
			const boot = new Boot(this, interaction, vmCfg);
			await boot.poll();
			await boot.save();

			return;
		}

		this.log.warn("unknown interaction type", { interaction });
	}

  /**
	 * Run until an exit signal is sent to the process.
	 */
  async waitForExit() {
		await new Promise<void>((resolve, reject) => {
			process.on("SIGTERM", resolve);
			process.on("SIGINT", resolve);
		});
  }
}

/**
 * Stores MongoDB database client for database and collections for the Bot class's usage.
 */
interface BotDB {
	boots: Collection;
}

async function main(log) {
  const bot = new Bot(CFG, log);
  await bot.init();

	await bot.waitForExit();

  await bot.cleanup();
	
}

// Invoke main
const log = winston.createLogger({
	format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.prettyPrint()
  ),
	level: "debug",
	transports: [
		new winston.transports.Console(),
	],
});

main(log)
  .then(() => {
		log.info("done");
	  process.exit(0);
  })
  .catch((e) => {
	  log.error("failed to run main", { error: e });
	  process.exit(1);
  });
