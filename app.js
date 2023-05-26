'use strict';
const pm2 = require('pm2');
const pmx = require('pmx');
const request = require('request');
const Discord = require('discord.js');

function ansiRegex({onlyFirst = false} = {}) {
	const pattern = [
	    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
		'(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
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
var conf = pmx.initModule();

// initialize buffer and queue_max opts
// buffer seconds can be between 1 and 5
conf.buffer_seconds = (conf.buffer_seconds > 0 && conf.buffer_seconds < 5) ? conf.buffer_seconds : 1;

// queue max can be between 10 and 100
conf.queue_max = (conf.queue_max > 10 && conf.queue_max <= 100) ? conf.queue_max : 100;

// create the message queue
var messages = [];

// create the suppressed object for sending suppression messages
var suppressed = {
  isSuppressed: false,
  date: new Date().getTime()
};


// Function to send event to Discord's Incoming Webhook
function sendToDiscord(message) {

  var description = message.description;

  // If a Discord URL is not set, we do not want to continue and nofify the user that it needs to be set
  if (!conf.discord_url) {
    return console.error("There is no Discord URL set, please set the Discord URL: 'pm2 set pm2-discord:discord_url https://[discord_url]'");
  }

  // The JSON payload to send to the Webhook
  var payload = {
    "content" : description
  };

  // Options for the post request
  var options = {
    method: 'post',
    body: payload,
    json: true,
    url: conf.discord_url
  };

  // Finally, make the post request to the Discord Incoming Webhook
  request(options, function(err, res, body) {
    if (err) {
      return console.error(err);
    }
    /* A successful POST to Discord's webhook responds with a 204 NO CONTENT */
    if (res.statusCode !== 204) {
      console.error("Error occured during the request to the Discord webhook");
    }
  });
}

// Function to get the next buffer of messages (buffer length = 1s)
function bufferMessage() {
  var nextMessage = messages.shift();

  if (!conf.buffer) { return nextMessage; }

  nextMessage.buffer = [nextMessage.description];

  // continue shifting elements off the queue while they are the same event and 
  // timestamp so they can be buffered together into a single request
  while (messages.length && 
    (messages[0].timestamp >= nextMessage.timestamp && 
      messages[0].timestamp < (nextMessage.timestamp + conf.buffer_seconds)) && 
    messages[0].event === nextMessage.event) {

    // append description to our buffer and shift the message off the queue and discard it
    nextMessage.buffer.push(messages[0].description);
    messages.shift();
  }

  // join the buffer with newlines
  nextMessage.description = nextMessage.buffer.join("\n");

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
          description: 'Messages are being suppressed due to rate limiting.'
      });
    }
    messages.splice(conf.queue_max, messages.length);
  }

  // If the suppression message has been sent over 1 minute ago, we need to reset it back to false
  if (suppressed.isSuppressed && suppressed.date < (new Date().getTime() - 60000)) {
    suppressed.isSuppressed = false;
  }

  // Wait 10 seconds and then process the next message in the queue
  setTimeout(function() {
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

  var msg = altDescription || data.data;
  if (typeof msg === "object") {
    msg = JSON.stringify(msg);
  } 

  messages.push({
    name: data.process.name,
    event: eventName,
    description: stripAnsi(msg),
    timestamp: Math.floor(Date.now() / 1000),
  });
}

// Start listening on the PM2 BUS
pm2.launchBus(function(err, bus) {

    // Listen for process logs
    if (conf.log) {
      bus.on('log:out', function(data) {
        createMessage(data, 'log');
      });
    }

    // Listen for process errors
    if (conf.error) {
      bus.on('log:err', function(data) {
        createMessage(data, 'error');
      });
    }

    // Listen for PM2 kill
    if (conf.kill) {
      bus.on('pm2:kill', function(data) {
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
      bus.on('process:exception', function(data) {
        createMessage(data, 'exception');
      });
    }

    // Listen for PM2 events
    bus.on('process:event', function(data) {
      if (!conf[data.event]) { return; }
      var msg = 'The following event has occured on the PM2 process ' + data.process.name + ': ' + data.event;
      createMessage(data, data.event, msg);
    });

    // Start the message processing
    processQueue();

});

console.log('Config:', conf);

if (conf.discord_bot_token) {
  console.log('Discord bot token found:', conf.discord_bot_token);

  const client = new Discord.Client({
    intents: 1024
  });

  // Discord Bot
  client.once('ready', () => {
      console.log('Discord bot is ready!');
  });

  client.on('message', message => {
      console.log(message);
      if (!message.content.startsWith('!') || message.author.bot) return;

      const args = message.content.slice(1).trim().split(' ');
      const command = args.shift().toLowerCase();

      if (command === 'start') {
          const processName = args[0];
          pm2.start(processName, (err, proc) => {
              if (err) {
                  message.reply(`Couldn't start process ${processName}`);
              } else {
                  message.reply(`Started process ${processName}`);
              }
          });
      } else if (command === 'stop') {
          const processName = args[0];
          pm2.stop(processName, (err, proc) => {
              if (err) {
                  message.reply(`Couldn't stop process ${processName}`);
              } else {
                  message.reply(`Stopped process ${processName}`);
              }
          });
      } else if (command === 'restart') {
          const processName = args[0];
          pm2.restart(processName, (err, proc) => {
              if (err) {
                  message.reply(`Couldn't restart process ${processName}`);
              } else {
                  message.reply(`Restarted process ${processName}`);
              }
          });
      }
  });

  client.login(conf.discord_bot_token);
}