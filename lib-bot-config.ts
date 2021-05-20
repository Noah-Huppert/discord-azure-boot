/**
 * Configures bot.
 */
export default interface BotConfig {
  /**
	 * Azure client information.
	 */
  azure: {
	  /**
	   * Azure subscription ID in which virtual machines are running.
	   */
	  subscriptionID: string;

	  /**
	   * Azure directory ID.
	   */
	  directoryID: string;

	  /**
	   * Azure application ID.
	   */
	  applicationID: string;

	  /**
	   * Azure access token.
	   */
	  accessToken: string;
  };

  /**
	 * MongoDB information.
	 */
  mongodb: {
	  /**
	   * A mongodb:// connection URI. 
	   */
	  connectionURI: string;

	  /**
	   * Name of database in which to store bot data.
	   */
	  dbName: string;
  };

	/**
	 * Discord API client information.
	 */
	discord: {
		/**
		 * If provided the command will be limited to a single Discord server. Set to null if a global command should be created.
		 */
		guildID: string | null;

		/**
		 * Discord API application ID.
		 */
		applicationID: string;
		
		/**
		 * ID of the Discord role which users must have in order to utilize the bot. Currently set to the berry boy role.
		 */
		permissionRoleID: string | null,

		/**
		 * Discord API application bot authentication token.
		 */
		botToken: string;
	};


  /**
	 * Define the Azure virtual machines which the bot is allowed to manage. Array of objects which specify vm details.
	 */
  vms: VMConfig[];
}


/**
 * Virtual machine details.
 */
export interface VMConfig {
	/**
	 * The name of the Azure resource group in which this virtual machine exists.
	 */
	resourceGroup: string;
	
	/**
	 * The name of the virtual machine in Azure.
	 */
	azureName: string;

	/**
	 * The name which users will see and use to refer to your virtual machine. This must be unique. Try not to include words like "server" as the messages generated for users includes specifiers like this already.
	 */
	friendlyName: string;
}

/**
 * Find a virtual machine configuration with a matching friendly name.
 * @param cfg The bot configuration to search.
 * @param name The virtual machine's friendly name to find.
 * @returns The virtual machine's configuration.
 * @throws {Error} If none or more than one virtual machine configuration blocks were found with a matching friendly name.
 */
export function vmCfgByFriendlyName(cfg: BotConfig, name: string): VMConfig {
	const vmSearch = cfg.vms.filter((vm) => vm.friendlyName === name);
	if (vmSearch.length === 0) {
		throw new Error(`could not find virtual machine configuration with friendly name "${name}"`);
	}
	
	if (vmSearch.length > 1) {
		throw new Error(`found more than one virtual machine configuration with friendly name "${name}", this should not happen as these friendly names should be unique`);
	}

	return vmSearch[0];
}
