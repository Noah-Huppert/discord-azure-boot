import BotConfig from "./lib-bot-config";
const cfg: BotConfig = {
  /**
	 * Azure client information.
	 */
  azure: {
	  /**
	   * Azure subscription ID in which virtual machines are running.
	   */
	  subscriptionID: "",

	  /**
	   * Azure directory ID.
	   */
	  directoryID: "",

	  /**
	   * Azure application ID.
	   */
	  applicationID: "",

	  /**
	   * Azure access token.
	   */
	  accessToken: "",
  },

  /**
	 * MongoDB information.
	 */
  mongodb: {
	  /**
	   * A mongodb:// connection URI. 
	   */
	  connectionURI: "mongodb://dev-discord-azure-boot@127.0.0.1:29017",

	  /**
	   * Name of database in which to store bot data.
	   */
	  dbName: "dev-discord-azure-boot",
  },

	/**
	 * Discord API client information.
	 */
	discord: {
		/**
		 * If provided the command will be limited to a single Discord server. Set to null if a global command should be created.
		 */
		guildID: null,

		/**
		 * Discord API application ID.
		 */
		applicationID: "",
		
		/**
		 * ID of the Discord role which users must have in order to utilize the bot. Set to null to allow any user to run the command.
		 */
		permissionRoleID: null,

		/**
		 * Discord API application bot authentication token.
		 */
		botToken: "",
	},


  /**
	 * Define the Azure virtual machines which the bot is allowed to manage. Array of objects which specify vm details.
	 */
  vms: [
	  /**
	   * Virtual machine details.
	   */
	  {
		  /**
		   * The name of the Azure resource group in which this virtual machine exists.
		   */
		  resourceGroup: "",
		  
		  /**
		   * The name of the virtual machine in Azure.
		   */
		  azureName: "",

		  /**
		   * The name which users will see and use to refer to your virtual machine. This must be unique. Try not to include words like "server" as the messages generated for users includes specifiers like this already.
		   */
		  friendlyName: "",
	  }
  ],
};
export default cfg;
