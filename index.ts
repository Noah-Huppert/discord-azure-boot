import * as msRestNodeAuth from "@azure/ms-rest-nodeauth";
import { ComputeManagementClient } from "@azure/arm-compute";
import {
	MongoClient,
	Database,
	Collection,
	ObjectId,
} from "mongodb";
import {
	Client as DiscordClient,
	CommandInteraction,
	Intents as DiscordIntents,
	InteractionResponseType,
	MessageEmbedOptions,
	TextChannel,
} from "discord.js";
import winston from "winston";
import fetch, {
	Response as FetchResponse,
} from "node-fetch";
import moment from "moment";

import BotConfig, { VMConfig, vmCfgByFriendlyName } from "./lib-bot-config";
import CFG from "./config";

/**
 * The interval at which ongoing power requests will be polled. In milliseconds.
 */
const ONGOING_POWER_REQUEST_INTERVAL = 5000;

/**
 * Discord HTTP API base URL.
 */
const DISCORD_HTTP_PATH = "https://discord.com/api/v9";

/**
 * The Discord permission integer required for the bot to function. See the Discord section in the README.md for details.
 */
const DISCORD_BOT_PERM = 2147483648;

/**
 * The boot server Discord slash command name.
 */
const BOOT_CMD_NAME = "boot";

/**
 * The shutdown server Discord slash command name.
 */
const SHUTDOWN_CMD_NAME = "shutdown";

const VM_POWER_STATE_DEALLOCATED = "PowerState/deallocated";
const VM_POWER_STATE_DEALLOCATING = "PowerState/deallocating";
const VM_POWER_STATE_RUNNING = "PowerState/running";
const VM_POWER_STATE_STARTING = "PowerState/starting";
const VM_POWER_STATE_STOPPED = "PowerState/stopped";
const VM_POWER_STATE_STOPPING = "PowerState/stopping";

/**
 * Color which represents an action in progress. Decimal version of hex code #ffff75 (old #e6e630).
 */
const DEC_COLOR_IN_PROGRESS = 16777077;

/**
 * Color which shows something is being turned on. Decimal version of hex code #7cff75 (old #39e630).
 */
const DEC_COLOR_START = 8191861;

/**
 * Color which shows something is being turned off. Decimal version of hex code #ff6161 (old #e01f1f).
 */
const DEC_COLOR_STOP = 16736609;

/**
 * The power state of an Azure virtual machine.
 */
enum VMPowerState {
	Deallocated = "PowerState/deallocated",
	Deallocating = "PowerState/deallocating",
	Running = "PowerState/running",
	Starting = "PowerState/starting",
	Stopped = "PowerState/stopped",
	Stopping = "PowerState/stopping",
}

/**
 * Determine which VMPowerState a string represents.
 * @param code The power state code.
 * @returns Corresponding VMPowerState or undefined if there is no valid mapping.
 */
function vmPowerStateFromStr(code: string): VMPowerState|undefined {
	switch (code) {
		case VM_POWER_STATE_DEALLOCATED:
			return VMPowerState.Deallocated;
			break;
		case VM_POWER_STATE_DEALLOCATING:
			return VMPowerState.Deallocating;
			break;
		case VM_POWER_STATE_RUNNING:
			return VMPowerState.Running;
			break;
		case VM_POWER_STATE_STARTING:
			return VMPowerState.Starting;
			break;
		case VM_POWER_STATE_STOPPED:
			return VMPowerState.Stopped;
			break;
		case VM_POWER_STATE_STOPPING:
			return VMPowerState.Stopping;
			break;
	}

	return undefined;
}

/**
 * Gets the non-terminal state which is related to the terminal state. This function will not work if the power rgument is not a terminal state.
 * @param power Terminal state for which to fetch non-terminal equivalent.
 * @returns Non-terminal equivilent.
 * @throws {Error} If power is a non terminal state.
 */
function nonTerminalForPower(power: VMPowerState): VMPowerState {
	switch (power) {
		case VMPowerState.Deallocated:
			return VMPowerState.Deallocating;
			break;
		case VMPowerState.Running:
			return VMPowerState.Starting;
			break;
		case VMPowerState.Stopped:
			return VMPowerState.Stopping;
			break;
	}

	throw new Error(`power state ${power} must be terminal, was not`);
}

/**
 * Creates a VMState for a VMPowerState.
 * @param power Power state from which to make VMState.
 * @returns VMState for power state.
 */
function vmStateFromPower(power: VMPowerState): VMState {
	// Determine if state is terminal
	let terminal = true;
	if (power === VMPowerState.Deallocating || power === VMPowerState.Starting || power === VMPowerState.Stopping) {
		terminal = false;
	}

	// Map friendly name
	let friendlyName = "Unknown";
	
	switch (power) {
		case VMPowerState.Deallocated:
			friendlyName = "Turned Off";
			break;
		case VMPowerState.Deallocating:
			friendlyName = "Turning Off";
			break;
		case VMPowerState.Running:
			friendlyName = "Running";
			break;
		case VMPowerState.Starting:
			friendlyName = "Starting";
			break;
		case VMPowerState.Stopped:
			friendlyName = "Stopped";
			break;
		case VMPowerState.Stopping:
			friendlyName = "Stopping";
			break;
	}

	return {
		code: power,
		friendlyName: friendlyName,
		terminal: terminal,
	};
}

/**
 * Describes details of any virtual machine state abstractly.
 */
interface VMState {
	/**
	 * The logical name of the state which can be used to identify it.
	 */
	code: string,

	/**
	 * A user friendly name for the state. Should be capitalized.
	 */
	friendlyName: string,

	/**
	 * Whether the state is final, and the does not lead to another state. For example "stopped" would be final but "stopping" would not as it would lead to "stopped".
	 */
	terminal: boolean,
}

/**
 * Information identifying a Discord interaction.
 */
interface InteractionID {
	/**
	 * The ID of the Discord interaction.
	 */
	id: string;

	/**
	 * The token for the Discord interaction.
	 */
	token: string;
}

/**
 * Wrapper around some Discord slash commands interaction HTTP API calls.
 */
class DiscordInteraction {
	/**
	 * Bot application context.
	 */
	bot: Bot;
	
	/**
	 * Identifier of Discord interaction.
	 */
	interaction_id: InteractionID;
	
	/**
	 * Create a new client.
	 * @param interaction_id Discord interaction identifier.
	 */
	constructor(bot: Bot, interaction_id: InteractionID) {
		this.bot = bot;
		this.interaction_id = interaction_id;
	}

	/**
	 * Wrapper which helps perform Discord HTTP API requests by setting the authorization and content type headers. Plus checks the response is okay.
	 * @param path API endpoint path relative to Discord API base. Include leading slash.
	 * @param opts Fetch request options.
	 * @returns Resolves when request completes.
	 * @throws {Error} If request did not succeed.
	 */
	async fetch(path: string, opts: object): Promise<FetchResponse> {
		if (!("headers" in opts)) {
			opts["headers"] = {};
		}

		opts["headers"]["Authorization"] = `Bot ${this.bot.discord.token}`;
		opts["headers"]["Content-Type"] = "application/json";
		
		const resp = await fetch(`${DISCORD_HTTP_PATH}${path}`, opts);

		if (resp.status < 200 || resp.status >= 300) {
			const body = await resp.text();
			throw new Error(`Failed to make Discord HTTP API request to ${path}, response had non-okay code ${resp.status}, response body "${body}"`);
		}

		return resp;
	}

	/**
	 * Create the initial interaction response.
	 * @param content The response message text content.
	 * @param [embeds] Array of embeds for response message.
	 * @returns Resolves when the Discord API request completes
	 */
	async newInitResp(content: string, embeds?: MessageEmbedOptions[]): Promise<void> {
		if (embeds === undefined) {
			embeds = [];
		}
		
		const resp = await this.fetch(`/interactions/${this.interaction_id.id}/${this.interaction_id.token}/callback`, {
			method: "POST",
			body: JSON.stringify({
				type: 4, // ChannelMessageWithSource https://discord.com/developers/docs/interactions/slash-commands#interaction-response-interactioncallbacktype
				data: {
					content: content,
					embeds: embeds,
				},
			}),
		});
	}

	/**
	 * Create a new initial defer response.
	 * @returns Resolves when Discord API request completes.
	 */
	async newDeferResp(): Promise<void> {
		const resp = await this.fetch(`/interactions/${this.interaction_id.id}/${this.interaction_id.token}/callback`, {
			method: "POST",
			body: JSON.stringify({
				type: 5, // DeferredChannelMessageWithSource https://discord.com/developers/docs/interactions/slash-commands#interaction-response-interactioncallbacktype
			}),
		});
	}

	/**
	 * Edit the initial interaction response.
	 * @param content New message content.
	 * @param [embeds] Array of new embeds.
	 * @returns Resolves when edit Discord API call completes.
	 */
	async editInitResp(content: string, embeds?: MessageEmbedOptions[]): Promise<void> {
		if (embeds === undefined) {
			embeds = [];
		}
		
		const resp = await this.fetch(`/webhooks/${this.bot.cfg.discord.applicationID}/${this.interaction_id.token}/messages/@original`, {
			method: "PATCH",
			body: JSON.stringify({
				content: content,
				embeds: embeds,
			}),
		});
	}
}

/**
 * A Discord message which can be editted to show the user the current status of an ongoing operation. This message can either be 
 */
class DiscordCtrlMsg {
	/**
	 * Application context.
	 */
	bot: Bot;
	
	/**
	 * Identifier of control message.
	 */
	id: DiscordCtrlMsgID;

	/**
	 * Create a new DiscordCtrlMsg.
	 * @param bot Application bot context.
	 * @param id ID of Discord control message.
	 */
	constructor(bot: Bot, id: DiscordCtrlMsgID) {
		this.bot = bot;
		this.id = id;
	}

	/**
	 * Edit the message's contents.
	 * @returns Resolves when message has been successfully edited.
	 * @throws {Error} If the message could not be found or could not be edited.
	 */
	async edit(content: string, embed?: MessageEmbedOptions): Promise<void> {
		switch (this.id.ctrl_type) {
			case DISCORD_CTRL_TXT_MSG:
				// If a regular Discord message, get it
				const guild = await this.bot.discord.guilds.cache.get(this.id.location.guildID);
				if (guild === undefined) {
					throw new Error(`could not edit message as its guild with ID ${this.id.location.guildID} could not be found`);
				}
				
				const channel = await guild.channels.cache.get(this.id.location.channelID);
				if (channel === undefined) {
					throw new Error(`could not edit message as its channel with ID ${this.id.location.channelID} could not be found`);
				}
				
				if (channel.isText() === true) {
					const msg = await (channel as TextChannel).messages.cache.get(this.id.msgID);

					// Then edit
					await msg.edit(content, { embed });
				} else {
					throw new Error(`could not edit message as its channel with ID ${this.id.location.channelID} was not a text channel`);
				}
				break;
			case DISCORD_CTRL_INTERACTION:
				// Create interaction client and edit message
				const interaction = new DiscordInteraction(this.bot, this.id);
				await interaction.editInitResp(content, [embed]);
				break;
		}
	}
}

/**
 * Indentifies a Discord message to use as a control message. Can either be a vanilla message or an interaction.
 */
type DiscordCtrlMsgID = DiscordCtrlTxtMsgID | DiscordCtrlInteractionID;

/**
 * Identifies a location in Discord where text messages can be sent.
 */
interface DiscordChannelLocation {
	/**
	 * ID of the Discord guild in which this message exists.
	 */
	guildID: string;

	/**
	 * ID of the Discord channel in which this message exists.
	 */
	channelID: string;
}

/**
 * Identifies a regular Discord message as the control message.
 */
type DiscordCtrlTxtMsgID = {
	ctrl_type: "TXT_MSG";

	/**
	 * Specifies a Discord guild and channel in which the message exists.
	 */
	location: DiscordChannelLocation;

	/**
	 * ID of the Discord message.
	 */
	msgID: string;
};

/**
 * Identifies a DiscordCtrlMsgID as a DiscordCtrlTxtMsgID.
 */
const DISCORD_CTRL_TXT_MSG = "TXT_MSG";

/**
 * Identifies a Discord interaction to use as the control message.
 */
interface DiscordCtrlInteractionID extends InteractionID {
	ctrl_type: "INTERACTION";
}

/**
 * Identifies a DiscordCtrlMsgID as a DiscordCtrlInteractionID.
 */
const DISCORD_CTRL_INTERACTION = "INTERACTION";

/**
 * Represents a request to change the power state of a virtual machine.
 */
class PowerRequest {
	/**
	 * The bot which holds application contexts.
	 */
	bot: Bot;

	/**
	 * The data which will be serialized into the database.
	 */
	data: PowerRequestData;
	
	/**
	 * Construct a power request.
	 * @param bot Bot application context.
	 * @param ctrlMsgID Identifier of a Discord message which will be used to interact with the user.
	 * @param vmCfg The configuration of the virtual machine this power request modify.
	 * @param targetPower The power state which the request will try to make the virtual machine reach.
	 * @throws {Error} If targetPower is not a terminal state.
	 */
	constructor(bot: Bot, ctrlMsgID: DiscordCtrlMsgID, vmCfg: VMConfig, targetPower: VMPowerState) {
		this.bot = bot;
		this.data = {
			ctrl_msg_id: ctrlMsgID,
			vm_cfg: vmCfg,
			target_power: targetPower,
			stage: {
				current: "requested",
				flip_flop: true,
				requested: {},
			},
		};

		// Check targetPower is terminal
		const vmStatePower = vmStateFromPower(targetPower);
		if (vmStatePower.terminal === false) {
			throw new Error(`target power "${targetPower}" must be a terminal state`);
		}
	}

	/**
	 * Determine the number of power requests which are currently taking place on the specified virtual machine.
	 * @param bot Bot application context.
	 * @param vmCfg Specifies the virtual machine for which to find ongoing power requests.
	 * @returns Resolves with number of ongoing requests.
	 */
	static async OngoingCount(bot: Bot, vmCfg: VMConfig): Promise<number> {
		return await bot.db.power_requests.find({ "vm_cfg.friendlyName": vmCfg.friendlyName, "stage.current": "in_progress" }).count();
	}

	/**
	 * Get the power status of the virtual machine.
	 * @returns The virtual machine VMPowerState status. Returns undefined if there are no power states for the virtual machine.
	 */
	async powerState(): Promise<VMPowerState|undefined> {
		// Get status of virtual machine
		const vmInstance = await this.bot.azureCompute.virtualMachines.instanceView(this.data.vm_cfg.resourceGroup, this.data.vm_cfg.azureName);

		// possible values: https://docs.microsoft.com/en-us/dotnet/api/microsoft.azure.management.compute.fluent.powerstate?view=azure-dotnet#fields
		if (vmInstance.statuses === undefined) {
			this.bot.log.warn("powerState(): vm instance had no .statuses field", { vmInstance });
			return undefined;
		}
		
		const powerStates = vmInstance.statuses.filter((v) => v.code.indexOf("PowerState/") !== -1);

		if (powerStates.length === 0) {
			this.bot.log.warn("powerState(): vm instance  no PowerState/ type statuses", { vmInstance });
			return undefined;
		}

		const code = powerStates[powerStates.length-1].code;
		return vmPowerStateFromStr(code);
	}

	/**
	 * Returns an object used as the primary key in the database.
	 * @returns Object with primary key fields.
	 */
	pk(): object {
		return {
			"ctrl_msg_id": this.data.ctrl_msg_id,
		};
	}

	/**
	 * Save in database. Stores the database Id in .data._id.
	 * @returns Resolves when stored.
	 */
	async save(): Promise<void> {
		const res = await this.bot.db.power_requests.updateOne(this.pk(), { $set: this.data }, { upsert: true });
		this.data._id = res.upsertedId;
	}

	/**
	 * Load .data field values from the database.
	 * @returns Resolves when .data field has been loaded.
	 */
	async load(): Promise<void> {
		this.data = await this.bot.db.power_requests.findOne(this.pk());
	}

	/**
	 * Check the status of the virtual machine and perform the required action to make its power state match the request state. Should be called at a regular interval until the virtual machine is in the correct state.
	 * @returns Resolves when done processing. 
	 */
	async poll(): Promise<void> {
		try {
			// Flip the flip flopper (used for two frame animations over responses)
			this.data.stage.flip_flop = !this.data.stage.flip_flop;

			const ctrlMsgClient = new DiscordCtrlMsg(this.bot, this.data.ctrl_msg_id);

			// Get the current state of the VM
			const powerState = await this.powerState();

			// Check if power request has been marked as started
			if (this.data.stage.current === "requested") {
				// Mark as in progress so this power request gets polled in the future
				this.data.stage.current = "in_progress";
				this.data.stage.in_progress = {
					time: moment().valueOf(),
					start_power: powerState,
				};
			}

			// Setup a Discord embed to show the user
			let targetTitleWord = undefined;
			let targetColor = undefined;
			switch (this.data.target_power) {
				case VMPowerState.Deallocated:
					targetTitleWord = ":stop_sign: Shutdown";
					targetColor = DEC_COLOR_STOP;
					break;
				case VMPowerState.Running:
					targetTitleWord = ":rocket: Start";
					targetColor = DEC_COLOR_START;
					break;
				case VMPowerState.Stopped:
					targetTitleWord = ":pause_button: Suspend";
					targetColor = DEC_COLOR_STOP;
					break;
			}

			let waitEmoji = ":hourglass:";
			if (this.data.stage.flip_flop === false) {
				waitEmoji = ":hourglass_flowing_sand:";
			}
			
			let embed: MessageEmbedOptions = {
				title: `${targetTitleWord} ${this.data.vm_cfg.friendlyName} Server`,
				color: targetColor,
				fields: [],
			};

			const sendEmbed = async () => {
				embed.fields.reverse();
				await ctrlMsgClient.edit(undefined, embed);
			};

			// Duration fields
			if ("in_progress" in this.data.stage) {
				// Estimate duration from past invocations
				let estStr = "";
				
				const otherReqs = await this.bot.db.power_requests.find({ vm_cfg: this.data.vm_cfg, "stage.current": "success", "stage.in_progress.start_power": this.data.stage.in_progress.start_power }, { "stage.in_progress.time": true, "stage.success.time": true }).limit(10).toArray();
				
				if (otherReqs.length > 0) {
					const totalDiffs = otherReqs.map((doc) => {
							return doc.stage.success.time - doc.stage.in_progress.time;
					}).reduce((accm, v) => accm + v);
					const avrgMs = totalDiffs / otherReqs.length;
					const avrgT = moment.unix(avrgMs/1000);
					const avrgDurStr = moment.utc(avrgT).format("mm:ss");

					estStr = ` (est. ${avrgDurStr})`;
				}
					
				// Current duration
				const startT = moment.unix(this.data.stage.in_progress.time/1000);
				const now = moment();
				const runT = moment.utc(now.diff(startT)).format("mm:ss");

				embed.fields.push({
					name: "Duration",
					value: `${runT}${estStr}`,
					inline: true,
				});
			}
			
			if (powerState !== undefined) {
				const vmStatePower = vmStateFromPower(powerState);
				// Show user the current state
				if (powerState === this.data.target_power) {
					waitEmoji = ":sparkles:";
				}
				embed.fields.push({
					name: "Server Status",
					value: `${waitEmoji} ${vmStatePower.friendlyName}`,
					inline: true,
				});

				// Don't issue any orders to the virtual machine if it is in the middle of doing something
				if (vmStatePower.terminal === false) {
					embed.description = `Please wait a moment, the ${this.data.vm_cfg.friendlyName} server is ${vmStatePower.friendlyName} right now.`;
					embed.color = DEC_COLOR_IN_PROGRESS;
					await sendEmbed();
					return;
				}

				// Check if in the final state we requested
				if (powerState === this.data.target_power) {
					this.data.stage.current = "success";
					this.data.stage.success = {
						time: moment().valueOf(),
					};

					embed.description = `All done! The ${this.data.vm_cfg.friendlyName} server is ${vmStatePower.friendlyName} now.`;
					await sendEmbed();
					return;
				}
			} else {
				// We don't know the virtual machine's power state, this could happen maybe when a vm is first created?
				embed.fields.push({
					name: "Server Status",
					value: `${waitEmoji} Unknown`,
					inline: true,
				});
				// this.bot.log.warn("the virtual machine's status was unknown, unsure why this happens", { data: this.data, powerState });
			}

			// Otherwise perform action to reach requested state
			switch (this.data.target_power) {
				case VMPowerState.Deallocated:
					await this.bot.azureCompute.virtualMachines.beginDeallocate(this.data.vm_cfg.resourceGroup, this.data.vm_cfg.azureName);
					break;
				case VMPowerState.Running:
					await this.bot.azureCompute.virtualMachines.beginStart(this.data.vm_cfg.resourceGroup, this.data.vm_cfg.azureName);
					break;
				case VMPowerState.Stopped:
					await this.bot.azureCompute.virtualMachines.beginPowerOff(this.data.vm_cfg.resourceGroup, this.data.vm_cfg.azureName);
					break;
			}

			const actionWord = vmStateFromPower(nonTerminalForPower(this.data.target_power)).friendlyName;

			embed.description = `Please wait a moment, the ${this.data.vm_cfg.friendlyName} server is just ${actionWord} now.`;
			embed.color = DEC_COLOR_IN_PROGRESS;
			await sendEmbed();
			return;
		} catch (e) {
			// Record error safely
			this.bot.log.error("failed to poll PowerRequest", { error: e, data: this.data });
			
			this.data.stage.current = "error";
			this.data.stage.error = {
				time: moment().valueOf(),
				internal: e,
				user: "an unexpected error occurred",
			};

			// See if we can reach the user and tell then something happened
			try {
				const ctrlMsgClient = new DiscordCtrlMsg(this.bot, this.data.ctrl_msg_id);
				await ctrlMsgClient.edit(`:warning: Sorry, ${this.data.stage.error.user}.`);
				return;
			} catch (e) {
				this.bot.log.error("while trying to inform the user of the failed power request encountered the error", { error: e });
				return;
			}
		}
	}
}

/**
 * Data serialized about a power request in the database.
 */
interface PowerRequestData {
	/**
	 * Database ID of power request.
	 */
	_id?: ObjectId,
	
	/**
	 * Identifier of a Discord message which will be used to interact with the user.
	 */
	ctrl_msg_id: DiscordCtrlMsgID;
	
	/**
	 * The virtual machine configuration for the server specified by the user.
	 */
	vm_cfg: VMConfig;

	/**
	 * The target virtual machine power state for the request. This must a terminal state.
	 */
	target_power: VMPowerState;

	/**
	 * Details about the current state of the power change process.
	 */
	stage: {
		/**
		 * The key in this stage object which holds information about the current stage.
		 */
		current: string;

		/**
		 * A variable which is inverted every time the power request is polled. This allows for 2 frame animations. Will be initialized to true.
		 */
		flip_flop: boolean,

		/**
		 * A non-terminal state. This is the first state a power request is set to be in right after it is initialized.
		 */
		requested: {},

		/**
		 * A non-terminal state. Indicates the power change is currently taking place.
		 */
		in_progress?: {
			/**
			 * The unix time when the progress began.
			 */
			time: number;

			/**
			 * The virtual machine's power state before the power request started any changes.
			 */
			start_power: VMPowerState;
		};

		/**
		 * A terminal state. Indicates the power change succeeded.
		 */
		success?: {
			/**
			 * The unix time when the success occurred.
			 */
			time: number;
		};

		/**
		 * A terminal state. Indicates an error occurred during the power change process.
		 */
		error?: {
			/**
			 * The unix time when the error occurred.
			 */
			time: number;
			
			/**
			 * Internal error details. Not to be shown to the user.
			 */
			internal: string;

			/**
			 * User friendly error message.
			 */
			user: string;
		};
	};
}

/**
 * A request from a user to boot a server. Starts the server then automatically stops the server later.
 */
class BootRequest {
	/**
	 * Bot which holds application context.
	 */
	bot: Bot;

	/**
	 * Information about boot request which is stored in database.
	 */
	data: BootRequestData;

	/**
	 * Create a new BootRequestData. In order for poll() to do anything initBoot() must be called to start the whole process.
	 * @param bot The bot application context.
	 * @param vmCfg The configuration for the virtual machine to boot.
	 * @param followUpLocation The Discord channel where follow up messages about this boot request can be sent.
	 */
	constructor(bot: Bot, vmCfg: VMConfig, followUpLocation: DiscordChannelLocation) {
		this.bot = bot;
		this.data = {
			vm_cfg: vmCfg,
			follow_up_location: followUpLocation,
			stage: {
				current: BootRequestStage.Requested,
				requested: {},
			},
		};
	}

	/**
	 * Start the boot process by creating a new PowerRequest which uses a Discord interaction as the control message. Stores the PowerRequest's database ID in the .data.stage.booting.power_request_id field.
	 * @param ctrlMsgID Identifying information of a Discord message to use as a control message.
	 * @returns Resolves when the PowerRequest has been created and saved in the database.
	 */
	async initBoot(ctrlMsgID: DiscordCtrlMsgID) {
		const powerReq = new PowerRequest(this.bot, ctrlMsgID, this.data.vm_cfg, VMPowerState.Running);
		await powerReq.save();

		this.data.stage.current = BootRequestStage.Booting,
		this.data.stage.booting = {
			power_request_id: powerReq.data._id,
		};
	}

	/**
	 * Store data in the database.
	 * @returns Resolves when the data has been saved successfully.
	 */
	async save(): Promise<void> {
		if ("_id" in this.data) {
			// If a database document already exists
			await this.bot.db.boot_requests.updateOne({ _id: this.data._id }, { $set: this.data });
		} else {
			// No document in database for this boot request, insert one
			const res = await this.bot.db.boot_requests.insertOne(this.data);
			this.data._id = res.insertedId;
		}
	}

	/**
	 * Loads data from the database.
	 * @returns Resolves when the data has been successfully loaded.
	 * @throws {Error} If there is no .data._id field value.
	 */
	async load(): Promise<void> {
		if (!("_id" in this.data)) {
			throw new Error(`No database _id field stored for this boot request, so cannot load it from the database`);
		}

		this.data = await this.bot.db.boot_requests.findOne({ _id: this.data._id });
	}

	/**
	 * Perform the required action based on the current state of the boot request. 
	 * @returns Resolves when any actions have been completed. Meant to be real time so should not block for too long.
	 */
	async poll(): Promise<void> {
		// If booting the virtual machine check if done yet
		// TODO

		// TODO: Set expire time after boot is done
		// TODO: Send warning message
		// TODO: Make PowerRequest to shutdown when expired
	}
}

/**
 * Boot request information which is stored in the database.
 */
interface BootRequestData {
	/**
	 * Database ID of boot request.
	 */
	_id?: ObjectId,
	
	/**
	 * The virtual machine which the user requested be started.
	 */
	vm_cfg: VMConfig;

	/**
	 * Location where follow up messages about this boot request can be sent.
	 */
	follow_up_location: DiscordChannelLocation;

	/**
	 * Information about the current state of the boot request lifecycle.
	 */
	stage: {
		current: BootRequestStage;
		
		requested: {};

		booting?: {
			/**
			 * ID of the power request which is starting up the machine.
			 */
			power_request_id: ObjectId;
		};

		running?: {
			/**
			 * The unix time at which the boot request will expire and the server will be shut off.
			 */
			expire_time: number;

			/**
			 * Identifying information for a control message which can be used to communicate expiration warning information. If undefined then one has not been sent.
			 */
			expire_ctrl_msg_id?: DiscordCtrlMsgID;
		};

		shutting_down?: {
			/**
			 * ID of the power request which is shutting down the virtual machine.
			 */
			power_request_id: ObjectId;
		};

		success?: {};

		error?: {};
	};
}

/**
 * Indicates the stages of a BootRequest's life cycle.
 */
enum BootRequestStage {
	/**
	 * Non-terminal state. The request has just been submitted and initialized but nothing has been done yet.
	 */
	Requested = "requested",

	/**
	 * Non-terminal state. The virtual machine is in the process of booting.
	 */
	Booting = "booting",

	/**
	 * Non-terminal state. The virtual machine is running.
	 */
	Running = "running",

	/**
	 * Non-terminal state. The virtual machine is being shut down.
	 */
	ShuttingDown = "shutting_down",

	/**
	 * Terminal state. The boot request concluded successfully.
	 */
	Success = "success",

	/**
	 * Terminal state. The boot request failed.
	 */
	Error = "error",
}
	

/**
 * Provides bot functionality. The init() method must be called before anything else can be called.
 */
class Bot {
	cfg: BotConfig;
	log: winston.Logger;
	azureCompute: ComputeManagementClient;
	mongoClient: MongoClient;
	mongoDB: Database;
	db: BotDB;
	discord: DiscordClient;
	pollOngoingInterval: NodeJS.Timeout;
	
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
		this.log.info("trying to authenticate with azure");
		
	  const azureCreds = (await msRestNodeAuth.loginWithServicePrincipalSecretWithAuthResponse(this.cfg.azure.applicationID, this.cfg.azure.accessToken, this.cfg.azure.directoryID)).credentials;

	  this.azureCompute = new ComputeManagementClient(azureCreds, this.cfg.azure.subscriptionID);
		this.log.info("authenticated with azure");

	  // Ensure all the virtual machines the user specified actually exist
	  try {
		  await Promise.all(this.cfg.vms.map(async (vm) => {
				await this.azureCompute.virtualMachines.get(vm.resourceGroup, vm.azureName);
		  }));
	  } catch (e) {
		  throw new Error(`Failed to find all virtual machines specified in the configuration: ${e}`);
	  }

	  // Connect to MongoDB
		this.log.info("trying to connect to mongodb");
	  this.mongoClient = new MongoClient(this.cfg.mongodb.connectionURI, { useUnifiedTopology: true });
	  await this.mongoClient.connect();
		this.mongoDB = this.mongoClient.db(this.cfg.mongodb.dbName);
		this.db = {
			power_requests: this.mongoDB.collection("power_requests"),
			boot_requests: this.mongoDB.collection("boot_requests"),
		};
		
		this.log.info("connected to mongodb");

		// Connect to Discord
		this.log.info(`invite the discord bot: https://discord.com/api/oauth2/authorize?client_id=${this.cfg.discord.applicationID}&scope=bot&permissions=${DISCORD_BOT_PERM}`);
		this.log.info(`authorize the discord api application via oauth2: https://discord.com/api/oauth2/authorize?client_id=${this.cfg.discord.applicationID}&scope=applications.commands`);
		this.log.info("trying to connect to discord");

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
		this.discord.once("ready", async  () => {
			let cmds = this.discord.application.commands;
			if (this.cfg.discord.guildID !== null) {
				const guild = this.discord.guilds.cache.get(this.cfg.discord.guildID);

				if (guild === undefined) {
					throw new Error(`Could not find guild with ID ${this.cfg.discord.guildID}, maybe the bot doesn't have access to this guild (use the invitation link in the logs above)`);
				}

				cmds = guild.commands;
				this.log.info(`using guild ID ${this.cfg.discord.guildID} local slash commands`);
			}

			if (this.cfg.discord.permissionRoleID !== null) {
				this.log.info(`restricting Discord commands to users with role ID ${this.cfg.discord.permissionRoleID}`);
			}

			const VM_CHOICES = this.cfg.vms.map((vm) => {
				return {
					name: vm.friendlyName,
					value: vm.friendlyName,
				};
			});

			const useDefaultPerms = this.cfg.discord.permissionRoleID === null;
			
			const bootCmd = await cmds.create({
				name: BOOT_CMD_NAME,
				description: "Start a game server",
				options: [
					{
						name: "server",
						description: "The server to start",
						type: 3, // string
						required: true,
						choices: VM_CHOICES,
					},
				],
				defaultPermission: useDefaultPerms,
			});
			if (this.cfg.discord.permissionRoleID !== null) {
				await cmds.setPermissions(bootCmd, [{
					type: "ROLE",
					id: this.cfg.discord.permissionRoleID,
					permission: true,
				}]);
			}

			const shutdownCmd = await cmds.create({
				name: SHUTDOWN_CMD_NAME,
				description: "Turn off a game server",
				options: [
					{
						name: "server",
						description: "The server to shutdown",
						type: 3, // string
						required: true,
						choices: VM_CHOICES,
					},
				],
				defaultPermission: useDefaultPerms,
 			});
			if (this.cfg.discord.permissionRoleID !== null) {
				await cmds.setPermissions(shutdownCmd, [{
					type: "ROLE",
					id: this.cfg.discord.permissionRoleID,
					permission: true,
				}]);
			}

			this.log.info("registered discord slash commands");
			discordReadyProm.resolve();
		});

		this.discord.on("interaction", this.onDiscordCmd.bind(this));
		this.discord.login(this.cfg.discord.botToken);
		await discordReadyProm.promise;
		this.log.info("connected to discord");

		// Setup poll ongoing interval
		this.pollOngoingInterval = setInterval(this.pollOngoing.bind(this), ONGOING_POWER_REQUEST_INTERVAL);
		this.log.info("setup polling");
  }

  /**
	 * Gracefully stop.
	 */
  async cleanup() {
		// Stop poll ongoing interval
		clearInterval(this.pollOngoingInterval);
		
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
			const vmCfg = vmCfgByFriendlyName(this.cfg, optName);

			// Defer response until PowerRequest.poll() can update it
			await interaction.defer();

			// Determine if a power request is already running for this vm
			const otherReqs = await PowerRequest.OngoingCount(this, vmCfg);
			if (otherReqs > 0) {
				interaction.editReply(`Sorry, the ${vmCfg.friendlyName} server is busy right now. Please wait until other commands are finished working on this server.`);
				return;
			}

			// Setup boot request
			const ctrlMsgID: DiscordCtrlMsgID = {
				ctrl_type: DISCORD_CTRL_INTERACTION,
				id: interaction.id,
				token: interaction.token
			};
			const bootReq = new BootRequest(this, vmCfg, {
				guildID: interaction.guildID,
				channelID: interaction.channelID,
			});
			
			await bootReq.initBoot(ctrlMsgID);
			await bootReq.poll();
			await bootReq.save();

			return;
		} else if (interaction.commandName === SHUTDOWN_CMD_NAME) {
			// Find parameters about vm from config
			const optName = interaction.options[0].value;
			const vmCfg = vmCfgByFriendlyName(this.cfg, optName);

			// Defer response until PowerRequest.poll() can update it
			await interaction.defer();

			// Determine if a power request is already running for this vm
			const otherReqs = await PowerRequest.OngoingCount(this, vmCfg);
			if (otherReqs > 0) {
				interaction.editReply(`Sorry, the ${vmCfg.friendlyName} server is busy right now. Please wait until other commands are finished working on this server.`);
				return;
			}

			// Setup power request
			const powerReq = new PowerRequest(this, { ctrl_type: DISCORD_CTRL_INTERACTION, id: interaction.id, token: interaction.token }, vmCfg, VMPowerState.Deallocated);
			await powerReq.poll();
			await powerReq.save();

			return;
		}

		this.log.warn("unknown interaction type", { interaction });
	}

	/**
	 * Retrieve on-going power requests from the database and run their poll() method.
	 */
	async pollOngoing() {
		const ongoing = await this.db.power_requests.find({ "stage.current": { $in: [ "requested", "in_progress" ] }, }).toArray();

		await Promise.all(ongoing.map(async (data) => {
			const power_req = new PowerRequest(this, data.ctrl_msg_id, data.vm_cfg, data.target_power);
			await power_req.load();

			this.log.debug("polling power request", { ctrl_msg_id: power_req.data.ctrl_msg_id });

			await power_req.poll();

			await power_req.save();
		}));
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
	/**
	 * Power Requests collection.
	 */
	power_requests: Collection;

	/**
	 * Boot Requests collection.
	 */
	boot_requests: Collection;
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
