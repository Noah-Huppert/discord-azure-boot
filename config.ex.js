module.exports = {
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
		   * The name which users will see and use to refer to your virtual machine.
		   */
		  friendlyName: "",
	   }
    ],
};
