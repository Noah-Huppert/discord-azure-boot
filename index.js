const msRestNodeAuth = require("@azure/ms-rest-nodeauth");
const { ComputeManagementClient } = require("@azure/arm-compute");

class Bot {
    /**
	* Creates a partially setup Bot class. Before any other methods are run Bot.init() must be called.
	*/
    constructor() {
	   this.cfg = require("./config");
    }

    /**
	* Performs initialization of Bot. Performs async operations which could not be performed in the constructor.
	*/
    async init() {
	   this.azureCreds = (await msRestNodeAuth.loginWithServicePrincipalSecretWithAuthResponse(this.cfg.azure.applicationID, this.cfg.azure.accessToken, this.cfg.azure.directoryID)).credentials;

	   this.azureCompute = new ComputeManagementClient(this.azureCreds, this.cfg.azure.subscriptionID);
    }
}

async function main() {
    const bot = new Bot();
    await bot.init();
}

main()
    .then(() => {
	   console.log("Done");
	   process.exit(0)
    })
    .catch((e) => {
	   console.trace(e);
	   process.exit(1);
    });
