const pm2 = require('pm2');
const pmx = require('pmx');
const fs = require('fs');
const request = require('request');
const Discord = require('discord.js');
const childProcess = require('child_process');

function ansiRegex({ onlyFirst = false } = {}) {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|');

  return new RegExp(pattern, onlyFirst ? undefined : 'g');
}

function stripAnsi(string) {
  if (typeof string !== 'string') {
    throw new TypeError(`Expected a \`string\`, got \`${typeof string}\``);
  }

  return string.replace(ansiRegex(), '');
}

// Get the configuration from PM2
const conf = pmx.initModule();

// initialize buffer and queue_max opts
// buffer seconds can be between 1 and 5
conf.buffer_seconds =
  conf.buffer_seconds > 0 && conf.buffer_seconds < 5 ? conf.buffer_seconds : 1;

// queue max can be between 10 and 100
conf.queue_max =
  conf.queue_max > 10 && conf.queue_max <= 100 ? conf.queue_max : 100;

// create the message queue
const messages = [];

// create the suppressed object for sending suppression messages
const suppressed = {
  isSuppressed: false,
  date: new Date().getTime(),
};

// Function to send event to Discord's Incoming Webhook
function sendToDiscord(message) {
  const { description } = message;

  // If a Discord URL is not set, we do not want to continue and nofify the user that it needs to be set
  if (!conf.discord_url) {
    return console.error(
      new Date().toISOString(),
      "There is no Discord URL set, please set the Discord URL: 'pm2 set pm2-discord:discord_url https://[discord_url]'",
    );
  }

  // The JSON payload to send to the Webhook
  const payload = {
    content: description,
  };

  // Options for the post request
  const options = {
    method: 'post',
    body: payload,
    json: true,
    url: conf.discord_url,
  };

  // Finally, make the post request to the Discord Incoming Webhook
  request(options, function (err, res, body) {
    if (err) {
      return console.error(new Date().toISOString(), err);
    }
    /* A successful POST to Discord's webhook responds with a 204 NO CONTENT */
    if (res.statusCode !== 204) {
      console.error(
        new Date().toISOString(),
        'Error occured during the request to the Discord webhook for message',
      );
      console.log(
        new Date().toISOString(),
        'Error occured during the request to the Discord webhook for message',
        description,
        body,
      );
    }
  });
}

// Function to get the next buffer of messages (buffer length = 1s)
function bufferMessage() {
  const nextMessage = messages.shift();

  if (!conf.buffer) {
    return nextMessage;
  }

  nextMessage.buffer = [nextMessage.description];

  // continue shifting elements off the queue while they are the same event and
  // timestamp so they can be buffered together into a single request
  while (
    messages.length &&
    messages[0].timestamp >= nextMessage.timestamp &&
    messages[0].timestamp < nextMessage.timestamp + conf.buffer_seconds &&
    messages[0].event === nextMessage.event
  ) {
    // append description to our buffer and shift the message off the queue and discard it
    nextMessage.buffer.push(messages[0].description);
    messages.shift();
  }

  // join the buffer with newlines
  nextMessage.description = nextMessage.buffer.join('\n');

  // delete the buffer from memory
  delete nextMessage.buffer;

  return nextMessage;
}

// Function to process the message queue
function processQueue() {
  // If we have a message in the message queue, removed it from the queue and send it to discord
  if (messages.length > 0) {
    sendToDiscord(bufferMessage());
  }

  // If there are over conf.queue_max messages in the queue, send the suppression message if it has not been sent and delete all the messages in the queue after this amount (default: 100)
  if (messages.length > conf.queue_max) {
    if (!suppressed.isSuppressed) {
      suppressed.isSuppressed = true;
      suppressed.date = new Date().getTime();
      sendToDiscord({
        name: 'pm2-discord',
        event: 'suppressed',
        description: 'Messages are being suppressed due to rate limiting.',
      });
    }
    messages.splice(conf.queue_max, messages.length);
  }

  // If the suppression message has been sent over 1 minute ago, we need to reset it back to false
  if (
    suppressed.isSuppressed &&
    suppressed.date < new Date().getTime() - 60000
  ) {
    suppressed.isSuppressed = false;
  }

  // Wait 10 seconds and then process the next message in the queue
  setTimeout(function () {
    processQueue();
  }, 10000);
}

function createMessage(data, eventName, altDescription) {
  // we don't want to output pm2-discord's logs
  if (data.process.name === 'pm2-discord') {
    return;
  }
  // if a specific process name was specified then we check to make sure only
  // that process gets output
  if (conf.process_name !== null && data.process.name !== conf.process_name) {
    return;
  }

  let msg = altDescription || data.data;
  if (typeof msg === 'object') {
    msg = JSON.stringify(msg);
  }

  messages.push({
    name: data.process.name,
    event: eventName,
    description: stripAnsi(msg),
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('eval', [command], {
      ...options,
      env: process.env,
      shell: true,
    });
    child.on('close', (code) => {
      if (!code) {
        resolve();
      } else {
        reject(code);
      }
    });
  });
}

const startCommand = {
  data: new Discord.SlashCommandBuilder()
    .setName('start')
    .setDescription('Start a process')
    .addStringOption((option) =>
      option
        .setName('process')
        .setDescription('Proccess name')
        .setRequired(true),
    ),
  async execute(interaction) {
    console.log(new Date().toISOString(), 'interaction', interaction);
    await interaction.reply('Pong!');
  },
};

let projects = [];

try {
  projects = JSON.parse(fs.readFileSync(conf.projects_file, 'utf8'));
} catch (e) {
  console.log(new Date().toISOString(), e);
}

const deployCommand = {
  data: new Discord.SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Deploy a project')
    .addStringOption((option) =>
      option
        .setName('project')
        .setDescription('Project name')
        .setRequired(true)
        .addChoices(
          ...projects.map((project) => {
            return {
              name: project.name,
              value: project.name,
            };
          }),
        ),
    ),
  async execute(interaction) {
    const projectName = interaction.options.getString('project');

    const project = projects.find((p) => p.name === projectName);

    if (project) {
      await interaction.reply(`Deploying ${project.name}`);

      const response = await runCommand(project.cmd, { cwd: project.cwd });

      if (!response) {
        await interaction.followUp(`Deployed ${project.name}`);
      } else {
        await interaction.followUp(`Deploy failed with code ${response}`);
      }
    } else {
      await interaction.reply(`Project not found:( ${projectName}`);
    }
  },
};

const commandsToRegister = [/* startCommand,  */ deployCommand];

// Start listening on the PM2 BUS
pm2.launchBus(function (err, bus) {
  // Listen for process logs
  if (conf.log) {
    bus.on('log:out', function (data) {
      createMessage(data, 'log');
    });
  }

  // Listen for process errors
  if (conf.error) {
    bus.on('log:err', function (data) {
      createMessage(data, 'error');
    });
  }

  // Listen for PM2 kill
  if (conf.kill) {
    bus.on('pm2:kill', function (data) {
      messages.push({
        name: 'PM2',
        event: 'kill',
        description: data.msg,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for process exceptions
  if (conf.exception) {
    bus.on('process:exception', function (data) {
      createMessage(data, 'exception');
    });
  }

  // Listen for PM2 events
  bus.on('process:event', function (data) {
    if (!conf[data.event]) {
      return;
    }
    const msg = `The following event has occured on the PM2 process ${data.process.name}: ${data.event}`;
    createMessage(data, data.event, msg);
  });

  // Start the message processing
  processQueue();
});

console.log(new Date().toISOString(), 'Config:', conf);

if (conf.discord_bot_token && conf.client_id) {
  console.log(
    new Date().toISOString(),
    'Discord bot token found:',
    conf.discord_bot_token,
  );

  const client = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.MessageContent,
    ],
  });

  // Discord Bot
  client.once('ready', () => {
    console.log(new Date().toISOString(), 'Discord bot is ready!');
  });

  const commands = [];
  client.commands = new Discord.Collection();

  commandsToRegister.forEach((command) => {
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
  });

  client.on(Discord.Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(
        new Date().toISOString(),
        `No command matching ${interaction.commandName} was found.`,
      );
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(new Date().toISOString(), error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'There was an error while executing this command!',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command!',
          ephemeral: true,
        });
      }
    }
  });

  const rest = new Discord.REST().setToken(conf.discord_bot_token);

  // and deploy your commands!
  (async () => {
    try {
      console.log(
        new Date().toISOString(),
        `Started refreshing ${commands.length} application (/) commands.`,
      );

      // The put method is used to fully refresh all commands in the guild with the current set
      const data = await rest.put(
        Discord.Routes.applicationCommands(
          conf.client_id.replace('client', ''),
        ),
        { body: commands },
      );

      console.log(
        new Date().toISOString(),
        `Successfully reloaded ${data.length} application (/) commands.`,
      );
    } catch (error) {
      // And of course, make sure you catch and log any errors!
      console.error(new Date().toISOString(), error);
    }
  })();

  // client.on(Discord.Events.InteractionCreate, interaction => {
  //     console.log(interaction);
  //     if (!interaction.isChatInputCommand()) return;

  //     const command = interaction.commandName;

  //     if (command === 'start') {
  //       const processName = interaction.message.content.split(' ')[1];
  //       pm2.start(processName, (err, proc) => {
  //           if (err) {
  //             interaction.reply(`Couldn't start process ${processName}`);
  //           } else {
  //             interaction.reply(`Started process ${processName}`);
  //           }
  //       });
  //     } else if (command === 'stop') {
  //       const processName = interaction.message.content.split(' ')[1];
  //       pm2.stop(processName, (err, proc) => {
  //           if (err) {
  //             interaction.reply(`Couldn't stop process ${processName}`);
  //           } else {
  //             interaction.reply(`Stopped process ${processName}`);
  //           }
  //       });
  //     } else if (command === 'restart') {
  //       const processName = interaction.message.content.split(' ')[1];
  //       pm2.restart(processName, (err, proc) => {
  //           if (err) {
  //             interaction.reply(`Couldn't restart process ${processName}`);
  //           } else {
  //             interaction.reply(`Restarted process ${processName}`);
  //           }
  //       });
  //     }
  // });

  client.login(conf.discord_bot_token);
}
