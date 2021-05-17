const msRestNodeAuth = require("@azure/ms-rest-nodeauth");
const { ComputeManagementClient } = require("@azure/arm-compute");
const { MongoClient } = require("mongodb");
const Discord = require("discord.js");
const winston = require("winston");

/**
 * The Discord permission integer required for the bot to function. See the Discord section in the README.md for details.
 */
const DISCORD_BOT_PERM = 2147484672; // 2147483648; // 2147765312;

/**
 * The boot server Discord slash command name.
 */
const BOOT_CMD_NAME = "boot";

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
		this.bootsColl = this.mongoDB.collection("boots");
		this.log.debug("connected to mongodb");

		// Connect to Discord
		this.log.debug(`invite the discord bot: https://discord.com/api/oauth2/authorize?client_id=${this.cfg.discord.applicationID}&scope=bot&permissions=${DISCORD_BOT_PERM}`);
		this.log.debug("trying to connect to discord");

		this.discord = new Discord.Client({
			intents: [
				Discord.Intents.GUILDS,
				Discord.Intents.GUILD_MESSAGES,
			],
		});

		this.discord.once("ready", () => {
			let cmds = this.discord.application.commands;
			if (this.cfg.discord.guildID !== null) {
				cmds = this.discord.guilds.cache.get(this.cfg.discord.guildID).commands;
				this.log.debug(`using guild ID ${this.cfg.discord.guildID} local slash commands`);
			}
			
			cmds.create({
				name: BOOT_CMD_NAME,
				description: "Request a server be started so you can play on it",
			});

			this.log.debug("registered discord slash commands");
		});

		this.discord.on("interaction", this.onInteraction.bind(this));
		this.discord.login(this.cfg.discord.botToken);
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
	 * Runs whenever a Discord slash command is invoked.
	 * @param {Discord Interaction} interaction Discord interaction which was just created by a user invoking a bot's slash command.
	 */
	async onInteraction(interaction) {
		// Only handle slash commands
		if (interaction.isCommand() !== true) {
			return;
		}

		if (interaction.commandName === BOOT_CMD_NAME) {
			interaction.reply("hello slash cmds!");
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
