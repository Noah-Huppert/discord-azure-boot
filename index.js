const msRestNodeAuth = require("@azure/ms-rest-nodeauth");
const { ComputeManagementClient } = require("@azure/arm-compute");
const { MongoClient } = require("mongodb");
const Discord = require("discord.js");
const winston = require("winston");

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
 * Represents a request to boot a virtual machine.
 * @field {Bot} bot The bot instance.
 * @field {object} data Data to serialize in database.
 */
class Boot {
	/**
	 * Construct a boot request.
	 * @param {Discord Interaction} interaction The Disocrd interaction which triggered this boot.
	 * @param {object} vmCfg The configuration for a virtual machine found in the configuration file.
	 */
	constructor(bot, interaction, vmCfg) {
		this.bot = bot;
		this.data = { interaction, vmCfg };
	}

	/**
	 * Get the power status of the virtual machine.
	 * @returns {Promise<string|undefined>} The virtual machine PowerState status. Returns undefined if there are no power states for the virtual machine.
	 */
	async powerState() {
		// Get status of virtual machine
		const vmInstance = await this.bot.azureCompute.virtualMachines.instanceView(this.data.vmCfg.resourceGroup, this.data.vmCfg.azureName);
		// possible values: https://docs.microsoft.com/en-us/dotnet/api/microsoft.azure.management.compute.fluent.powerstate?view=azure-dotnet#fields
		const powerStates = vmInstance.statuses.filter((v) => v.indexOf("PowerState/") !== -1);
		if (powerStates.length === 0) {
			return undefined;
		}

		return powerStates[powerStates.length-1];
	}

	/**
	 * Save in database.
	 * @returns {Promise} Resolves when stored.
	 */
	async save() {
		await this.bot.db.boots.updateOne({ this.data.vmCfg }, this.data, { upsert: true });
	}

	/**
	 * Check the status of the virtual machine and perform the required action to boot it and update the user. Should be called at a regular interval until the virtual machine is booted.
	 */
	async poll() {
		const powerState = await this.powerState();
		switch (powerState) {
			case VM_POWER_STATE_
		}
	}
}

class Bot {
  /**
	 * Creates a partially setup Bot class. Before any other methods are run Bot.init() must be called.
	 * @param {Winston.Logger} log Parent logger.
	 */
  constructor(log) {
	  this.cfg = require("./config");
		this.log = log.child({});
  }

  /**
	 * Performs initialization of Bot. Performs async operations which could not be performed in the constructor.
	 * @throws {Error} If the bot fails to initialize.
	 */
  async init() {
	  // Authenticate with the Azure API
		this.log.debug("trying to authenticate with azure");
	  this.azureCreds = (await msRestNodeAuth.loginWithServicePrincipalSecretWithAuthResponse(this.cfg.azure.applicationID, this.cfg.azure.accessToken, this.cfg.azure.directoryID)).credentials;

	  this.azureCompute = new ComputeManagementClient(this.azureCreds, this.cfg.azure.subscriptionID);
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

		this.discord = new Discord.Client({
			intents: [
				Discord.Intents.GUILDS,
			],
		});

		let discordReadyProm = {};
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
			const boot = new Boot(this, vmCfg);
			await bot.poll();
			await boot.save();

			return;
		}

		this.log.warn("unknown interaction type", { interaction });
	}

	/**
	 * Process an interaction from the work queue.
	 * @param {Boot} boot The boot database document.
	 * @returns {Promise} Resolves when processing interaction is complete. Tries not to block for too long, should be real-time, the caller must set the interval to call.
	 */
	async processBoot(boot) {
		const vmInstance = await this.azureCompute.virtualMachines.instanceView(boot.vmCfg.resourceGroup, boot.vmCfg.azureName);
		// possible values: https://docs.microsoft.com/en-us/dotnet/api/microsoft.azure.management.compute.fluent.powerstate?view=azure-dotnet#fields
		const powerStates = vmInstance.statuses.filter((v) => v.indexOf("PowerState/") !== -1);
		let status = "unknown"
		if (powerStates.length === 0) {
			
		}
		const status = 
					}

	this.log.warn("unknown interaction type", { interaction });
}

	}

  /**
	 * Run until an exit signal is sent to the process.
	 */
  async waitForExit() {
		await new Promise((resolve, reject) => {
			process.on("SIGTERM", resolve);
			process.on("SIGINT", resolve);
		});
  }
}

async function main(log) {
  const bot = new Bot(log);
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
