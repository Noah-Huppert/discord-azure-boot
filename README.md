# Discord Azure Boot
Discord bot which starts and stops game servers running on Azure Virtual Machines.

# Table Of Contents
- [Overview](#overview)
- [Setup](#setup)
- [Development](#development)

# Overview
Allows trusted Discord users to start and stop Azure virtual machines. Useful if you are running a game server on Azure and want to allow friends to turn on the server. This bot also automatically shuts down servers after all users leave the voice chat (only if a user initially requested it turned on).

# Setup
## Azure Cloud
Setup an Application in your Active Directory:

1. Navigate to the "Azure Active Directory" dashboard page
2. Navigate to the "App Registrations" sub-page under the manage category
3. Click the "New registration" button to create a new App Registration, select "Accounts in this organizational directory only (Default Directory only - Single tenant)", no redirect URI, then register
4. On the created App Registration's overview page copy the "Application (client) ID" and "Directory (tenant) ID" for later
5. Navigate to the "Certificates & secrets" sub-page of the App Registration, under the manage category
6. Click the "New Client Secret" button, then hit "Add", copy its value for later use

Give the Application permission to view resources:

1. Navigate to the "Subscriptions" page by searching it in the top bar
2. Click on the subscription under which virtual machines exist
3. Navigate to the "Access control (IAM)" sub-page
4. Click the "Add role assignment" button
   1. Role: Select a role which allows the Application to list, get, stop, and start the virtual machines you wish this bot to manage, then click "Next"
   2. Members
     1. Assign access to: Select "User, group, or service principal"
	 2. Members: Click the "Select members" button, then select your Application (I've found that it will not show up in the initial list, and that you must type its name for it to show up), click select
     3. Click "Next"
   3. Review + assign: Click "Review + assign"

Gather information about virtual machines:

1. Navigate to the "Virtual Machines" dashboard page
2. Click on the virtual machine you wish to manage with this bot
3. Save the "Resource group" and virtual machine name for later

## Configuration File
Make a copy of `config.ex.js` named `config.js`. Edit this `config.js` file with your own values, make sure not to commit it to git.

Use the values saved from the [Azure Cloud setup](#azure-cloud) section.

# Development
Written with NodeJs + Yarn. MongoDB is used to store data about server start requests.

Install dependencies:

```
yarn install
```

To start MongoDB a Docker Compose file with MongoDB setup is provided. To start MongoDB using this file run:

```
docker-compose up -d
```

(You may run your own MongoDB server, just modify the `mongo` configuration values)

Follow instructions in [Setup](#setup) to create the necessary Azure resources and a configuration file.

Run the bot:

```
yarn start
```
