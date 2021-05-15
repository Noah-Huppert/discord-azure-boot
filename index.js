const azure = require("azure");

class Bot {
    constructor() {
	   this.cfg = require("./config");
	   console.log(this.cfg);
	   
	   this.azureClient = azure.createResourceManagementClient(new azure.TokenCloudCredentials({
		  subscriptionId: this.cfg.azure.subscriptionID,
		  token: this.cfg.azure.accessToken,
	   }));
    }
}

async function main() {
    const bot = new Bot();
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
