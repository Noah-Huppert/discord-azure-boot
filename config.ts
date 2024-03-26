import { promises as fs } from "fs";

import { z } from "zod";
import json5 from "json5";

/**
 * Virtual machine details.
 */
export const CVMConfig = z.object({
	/**
	 * The name of the Azure resource group in which this virtual machine exists.
	 */
	resourceGroup: z.string(),

	/**
	 * The name of the virtual machine in Azure.
	 */
	azureName: z.string(),

	/**
	 * The name which users will see and use to refer to your virtual machine. This must be unique. Try not to include words like "server" as the messages generated for users includes specifiers like this already.
	 */
	friendlyName: z.string(),
});
export type VMConfig = z.infer<typeof CVMConfig>;

/**
 * Configures bot.
 */
export const CBotConfig = z.object({
	/**
	 * Azure client information.
	 */
	azure: z.object({
		/**
	 	 * Azure subscription ID in which virtual machines are running.
	 	 */
		subscriptionID: z.string(),

		/**
	   	 * Azure directory ID.
	     */
		directoryID: z.string(),

		/**
	   	 * Azure application ID.
	     */
		applicationID: z.string(),

		/**
		 * Azure access token.
		 */
		accessToken: z.string(),
	}),

	/**
	 * MongoDB information.
	 */
	mongodb: z.object({
		/**
		 * A mongodb:// connection URI. 
		 */
		connectionURI: z.string(),

		/**
		 * Name of database in which to store bot data.
		 */
		dbName: z.string(),
	}),

	/**
	 * Discord API client information.
	 */
	discord: z.object({
		/**
		 * If provided the command will be limited to a single Discord server. Set to null if a global command should be created.
		 */
		guildID: z.optional(z.string()),

		/**
		 * Discord API application ID.
		 */
		applicationID: z.string(),

		/**
		 * ID of the Discord role which users must have in order to utilize the bot. Currently set to the berry boy role.
		 */
		permissionRoleID: z.optional(z.string()),

		/**
		 * Discord API application bot authentication token.
		 */
		botToken: z.string(),
	}),

	/**
	 * Define the Azure virtual machines which the bot is allowed to manage. Array of objects which specify vm details.
	 */
	vms: z.array(CVMConfig),
});
export type BotConfig = z.infer<typeof CBotConfig>;

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

/**
 * Load the BotConfig from a JSON file.
 * @argument path Path to JSON file to load
 */
export async function loadConfig(path: string): Promise<BotConfig> {
	const fileContents = await fs.readFile(path);
	const fileJSON = json5.parse(fileContents.toString());

	return CBotConfig.parseAsync(fileJSON);
}