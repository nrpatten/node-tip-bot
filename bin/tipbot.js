var irc   = require('irc'),
 winston  = require('winston'),
 fs       = require('fs'),
 yaml     = require('js-yaml'),
 coin     = require('node-altcoin'),
 tipbot   = require('node-tipbot-api'),
 webadmin = require('../lib/webadmin/app');

// check if the config file exists
if(!fs.existsSync('./config/config.yml')) {
  winston.error('Configuration file doesn\'t exist! Please read the README.md file first.');
  process.exit(1);
}

// handle sigint
process.on('exit', function() {
  winston.info('Exiting...');
  if(client != null) {
    client.disconnect('My master ordered me to leave.');
  }
});

// load settings
var settings = yaml.load(fs.readFileSync('./config/config.yml', 'utf-8'));

// Joke/random URL
var joke = (settings.joke.url);
var random = (settings.random.url);

// Ticker Options/Market URL change URL in config.yml
var allcoin = (settings.allcoin.url);
var allcoin2 = (settings.allcoin2.url);
var btce = (settings.btc.url);
var bittrex = (settings.bittrex.url);
var bittrex2 = (settings.bittrex2.url);

// load winston's cli defaults
winston.cli();

// write logs to file
if(settings.log.file) {
  winston.add(winston.transports.File, {
    filename: settings.log.file
  , level: 'info'});
}

// connect to coin json-rpc
winston.info('Connecting to coind...');

var coin = coin({
  host: settings.rpc.host
, port: settings.rpc.port
, user: settings.rpc.user
, pass: settings.rpc.pass
});

coin.getBalance(function(err, balance) {
  if(err) {
    winston.error('Could not connect to %s RPC API! ', settings.coin.full_name, err);
    process.exit(1);
    return;
  }

  var balance = typeof(balance) == 'object' ? balance.result : balance;
  winston.info('Connected to JSON RPC API. Current total balance is %d' + settings.coin.short_name, balance);
})

// run webadmin
if(settings.webadmin.enabled)
{
  winston.info('Running webadmin on port %d', settings.webadmin.port);
  webadmin.app(settings.webadmin.port, coin, settings, winston);
}

// connect to the server
winston.info('Connecting to the server...');

var client = new irc.Client(settings.connection.host, settings.login.nickname, {
  port:   settings.connection.port
, secure: settings.connection.secure
, channels: settings.channels
, userName: settings.login.username
, realName: settings.login.realname
, debug: settings.connection.debug
});

// gets user's login status
irc.Client.prototype.isIdentified = function(nickname, callback) {
  // request login status
 this.say('NickServ', 'ACC ' + nickname);

  // wait for response
  var listener = function(from, to, message) {
   // proceed only on NickServ's ACC response
    var regexp = new RegExp('^(\\S+) ACC (\\d)');
    if(from != undefined && from.toLowerCase() == 'nickserv' && regexp.test(message)) {
      var match = message.match(regexp);
      var user  = match[1];
      var level = match[2];

      // if the right response, call the callback and remove this listener
      if(user.toLowerCase() == nickname.toLowerCase()) {
        callback(level == 3);
        this.removeListener('notice', listener);
      }
    }
  }

  this.addListener('notice', listener);
}
irc.Client.prototype.getNames = function(channel, callback) {
  client.send('NAMES', channel);
  var listener = function(nicks) {
    var names = [];
    for(name in nicks) {
      names.push(name);
    }
    callback(names);
    this.removeListener('names' + channel, listener);
  }

  this.addListener('names' + channel, listener);
}

// gets a empty coin address
irc.Client.prototype.getAddress = function(nickname, callback) {
  winston.debug('Requesting address for %s', nickname);
  coin.send('getaccountaddress', nickname.toLowerCase(), function(err, address) {
    if(err) {
      winston.error('Something went wrong while getting address. ' + err);
      callback(err);

      return false;
    }

    callback(false, address);
  });
}

String.prototype.expand = function(values) {
  var global = {
    nick: client.nick
  }
  return this.replace(/%([a-zA-Z_]+)%/g, function(str, variable) {
    return typeof(values[variable]) == 'undefined' ? 
      (typeof(settings.coin[variable]) == 'undefined' ? 
        (typeof(global[variable]) == 'undefined' ?
          str : global[variable]) : settings.coin[variable]) : values[variable];
  });
}

// Load modules from modules folder
function reloadmodules(curr, prev) {
        client.removeAllListeners('message');
        fs.readdirSync('./modules').forEach(function (file) {
                client.addListener('message', function (from, channel, message, callback) {
                        delete require.cache[require.resolve('../modules/' + file)];
                        var response = require('../modules/' + file, true);
                        try {
                                filter = response.filter(from, channel, message);
                                if (filter) {
                                        response.action(from, channel, message, client);
                                }
                        } catch (err) {
                                winston.info(err);
                        }
                });
                winston.info('Added listener for ' + file);
        });
}
reloadmodules();

fs.watch(fs.realpathSync('modules'), reloadmodules);

// basic handlers
client.addListener('registered', function(message) {
  winston.info('Connected to %s.', message.server);

  client.say('NickServ', 'IDENTIFY ' + settings.login.nickserv_password);
});

client.addListener('error', function(message) {
  winston.error('Received an error from IRC network: ', message);
});

client.addListener('message', function(from, channel, message) {
  var match = message.match(/^(!?)(\S+)/);
  if(match == null) return;
  var prefix  = match[1];
  var command = match[2];

  if(settings.commands[command]) {
    if(channel == client.nick && settings.commands[command].pm === false) return;
    if(channel != client.nick && (settings.commands[command].channel === false || prefix != '!')) return;
  } else {
    return;
  }

  // if pms, make sure to respond to pms instead to itself
  if(channel == client.nick) channel = from;

  // comands that don't require identifying
  if(command == 'help' || command == 'terms' || command == 'commands' || command == 'bot')
  {
    for(var i = 0; i < settings.messages[command].length; i++) {
      var message = settings.messages[command][i];
      client.say(channel, message.expand({}));
    }

    return;
  }

  // if not that, message will be undefined for some reason
  // todo: find a fix for that
  var msg = message;
  client.isIdentified(from, function(status) {
    var message = msg;
    // check if the sending user is logged in (identified) with nickserv
    if(!status) {
      winston.info('%s tried to use command `%s`, but is not identified.', from, message);
      client.say(channel, settings.messages.not_identified.expand({name: from}));
      return;
    }
	switch(command) {
      case 'rain':
        var match = message.match(/^.?rain ([\d\.]+) ?(\d+)?/);
        if(match == null || !match[1]) {
          client.say(channel, 'Usage: !rain <amount> [max people]');
          return;
        }

        var amount = Number(match[1]);
        var max = Number(match[2]);

        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[2]}));
          return;
        }

        if(isNaN(max) || max < 1) {
          max = false;
        }
        else
        {
          max = Math.floor(max);
        }

        coin.getBalance(from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            client.getNames(channel, function(names) {
              // remove tipper from the list
              names.splice(names.indexOf(from), 1);
              names.splice(names.indexOf(client.nick), 1);
              // shuffle the array
              for(var j, x, i = names.length; i; j = Math.floor(Math.random() * i), x = names[--i], names[i] = names[j], names[j] = x);

              max = max ? Math.min(max, names.length) : names.length;
              if(max == 0) return;
              var whole_channel = false;
              if(max == names.length) whole_channel = true;
              names = names.slice(0, max);

              if(amount / max < settings.coin.min_rain) {
                client.say(channel, settings.messages.rain_too_small.expand({from: from, amount: amount, min_rain: settings.coin.min_rain * max}));
                return;
              }

              for (var i = 0; i < names.length; i++) {
                coin.move(from.toLowerCase(), names[i].toLowerCase(), amount / max, function(err, reply) {
                  if(err || !reply) {
                    winston.error('Error in !tip command', err);
                    return;
                  }
                });
              }

              client.say(channel, settings.messages.rain.expand({name: from, amount: amount / max, list: whole_channel ? 'the whole channel' : names.join(', ')}));
            });
          } else {
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        })
        break;
      case 'ticker':
        if(settings.allcoin.enabled) {
          var match = message.match(/^.?ticker (\S+)$/);
          if(match === null) {
              var user = from.toLowerCase();
              tipbot.sendCustomRequest(allcoin, function(data) {
              var info = data;
              client.say(channel, settings.messages.ticker.expand({name: user, coin: settings.allcoin.coin, trade_price: info.data.trade_price, exchange_volume: info.data.exchange_volume, type_volume: info.data.type_volume}));
              });
          } else {
          var user = from.toLowerCase();
          var str = match[1];
          tipbot.sendCustomRequest(allcoin2 + str + '_BTC', function(data, error) {
          var info = data;
             if(error || info.code === 0) {
               client.say(channel, settings.messages.tickererr.expand({name: user, coin: str}));
             return;
             }
               client.say(channel, settings.messages.ticker.expand({name: user, coin: str, trade_price: info.data.trade_price, exchange_volume: info.data.exchange_volume, type_volume: info.data.type_volume}));
            });
          }
           } else {
          return;
        }
        break;
      case 'cryptsy':
        if(settings.cryptsy.enabled) {
          var user = from.toLowerCase();
          tipbot.sendCustomRequest(cryptsy, function(data, err) {
           if(err) {
            winston.error('Error in !ticker2 command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
           return;
          }
          var info = data;
          winston.info(user, 'Fetched Price From Cryptsy', info.return.markets.FST.lasttradeprice, info.return.markets.FST.volume);
          client.say(channel, settings.messages.ticker2.expand({name: user, coin: settings.cryptsy.coin, price: info.return.markets.FST.lasttradeprice, volume: info.return.markets.FST.volume}));
          });
          } else {
         return;
        }
        break;
      case 'btc':
        if(settings.btc.enabled) {
          var user = from.toLowerCase();
          tipbot.sendCustomRequest(btce, function(data, err) {
           if(err) {
            winston.error('Error in !btce command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
           return;
          }
          var info = data;
          winston.info(user, 'Fetched Price From btce', info.btc_usd.buy, info.btc_usd.vol_cur);
          client.say(channel, settings.messages.btc.expand({name: user, coin: settings.btc.coin, price_dollar: info.btc_usd.buy, volume: info.btc_usd.vol_cur}));
          });
          } else {
         return;
        }
        break;
      case 'bittrex':
        if(settings.bittrex.enabled) {
          var match = message.match(/^.?bittrex (\S+)$/);
          if(match === null) {
              var user = from.toLowerCase();
              tipbot.sendCustomRequest(bittrex, function(data) {
              var info = data;
              client.say(channel, settings.messages.bittrex.expand({name: user, coin: settings.bittrex.coin, last: info.result[0].Last.toFixed(8), basevolume: info.result[0].BaseVolume.toFixed(8), volume: info.result[0].Volume}));
              });
          } else {
          var user = from.toLowerCase();
          var str = match[1];
          tipbot.sendCustomRequest(bittrex2 + 'BTC-' + str, function(data, error) {
          var info = data;
             if(error || info.success === false) {
               client.say(channel, settings.messages.bittrexerr.expand({name: user, coin: str}));
             return;
             }
               client.say(channel, settings.messages.bittrex.expand({name: user, coin: str, last: info.result[0].Last.toFixed(8), basevolume: info.result[0].BaseVolume.toFixed(8), volume: info.result[0].Volume}));
            });
          }
           } else {
          return;
        }
        break;
      case 'joke':
        if(settings.joke.enabled) {
          var user = from.toLowerCase();
          tipbot.sendCustomRequest(joke, function(data, err) {
           if(err) {
            winston.error('Error in !joke command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
           return;
          }
          var info = data;
          winston.info(user, 'Fetched Joke', info.value.joke);
          client.say(channel, settings.messages.joke.expand({name: user, joke: info.value.joke}));
          });
          } else {
         return;
        }
        break;
      case 'random':
        if(settings.random.enabled) {
          var user = from.toLowerCase();
          tipbot.sendCustomRequest(random, function(data, err) {
           if(err) {
            winston.error('Error in !random command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
           return;
          }
          var info = data;
          winston.info(user, 'Fetched Random Quote', info.quote);
          client.say(channel, settings.messages.random.expand({name: user, random: info.quote}));
          });
          } else {
         return;
        }
        break;
      case 'tip':
        var match = message.match(/^.?tip (\S+) ([\d\.]+)/);
		if(match == null || match.length < 3) {
          client.say(channel, 'Usage: !tip <nickname> <amount>')
          return;
        }
        var to     = match[1];
        var amount = Number(match[2]);

        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[2]}));
          return;
        }

        if(to.toLowerCase() == from.toLowerCase()) {
          client.say(channel, settings.messages.tip_self.expand({name: from}));
          return;
        }

        if(amount < settings.coin.min_tip) {
          client.say(channel, settings.messages.tip_too_small.expand({from: from, to: to, amount: amount}));
          return;
        }
        // check balance with min. 5 confirmations
        coin.getBalance(from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

         if(balance >= amount) {
            coin.send('move', from.toLowerCase(), to.toLowerCase(), amount, function(err, reply) {
              if(err || !reply) {
                winston.error('Error in !tip command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }
              
              winston.info('%s tipped %s %d%s', from, to, amount, settings.coin.short_name)
              client.say(channel, settings.messages.tipped.expand({from: from, to: to, amount: amount}));
            });
          } else {
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        });
        break;
        
      case 'address':
        var user = from.toLowerCase();
        client.getAddress(user, function(err, address) {
          if(err) {
            winston.error('Error in !address command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
                  var user = from.toLowerCase();
          client.say(channel, settings.messages.deposit_address.expand({name: user, address: address}));
        });
        break;
        
      case 'diff':
        coin.getDifficulty(function(err, get_difficulty) {
          if(err) {
            winston.error('Error in !getdiff command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
 		var get_difficulty = typeof(get_difficulty) == 'object' ? get_difficulty.result : get_difficulty;

        client.say(channel, settings.messages.getdiff.expand({diff: get_difficulty}));
        });
        break;

      case 'block':
        coin.getblockcount(function(err, get_blockcount) {
          if(err) {
            winston.error('Error in !getblock command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
                var get_blockcount = typeof(get_blockcount) == 'object' ? get_blockcount.result : get_blockcount;

        client.say(channel, settings.messages.getblock.expand({block: get_blockcount}));
        });
        break;

      case 'info':
        coin.getnetworkhashps(function(err, get_networkhps) {
          if(err) {
            winston.error('Error in !networkhps command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
                var get_networkhps = typeof(get_networkhps) == 'object' ? get_networkhps.result : get_networkhps;
          coin.getDifficulty(function(err, get_difficulty) {
          if(err) {
            winston.error('Error in !getdiff command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          } 
                var get_difficulty = typeof(get_difficulty) == 'object' ? get_difficulty.result : get_difficulty;
            coin.getblockcount(function(err, get_blockcount) {
          if(err) {
            winston.error('Error in !info command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var get_blockcount = typeof(get_blockcount) == 'object' ? get_blockcount.result : get_blockcount;
          if (get_networkhps < 10000000) {
            winston.info('khs', get_networkhps);
            client.say(channel, settings.messages.infok.expand({networkhps: (get_networkhps/100000).toFixed(2), diff: get_difficulty, block: get_blockcount}));
          }
        else {
          if (get_networkhps < 1000000000) {
            winston.info('mhs', get_networkhps);
            client.say(channel, settings.messages.infom.expand({networkhps: (get_networkhps/1000000).toFixed(2), diff: get_difficulty, block: get_blockcount}));
          }
        else {
          if (get_networkhps < 10000000000) {
            winston.info('ghs', get_networkhps);
            client.say(channel, settings.messages.infog.expand({networkhps: (get_networkhps/1000000000).toFixed(2), diff: get_difficulty, block: get_blockcount}));
             }
            }
           }
          });
         });
        });
        break;

      case 'networkhps':
        coin.getnetworkhashps(function(err, get_networkhps) {
          if(err) {
            winston.error('Error in !networkhps command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var get_networkhps = typeof(get_networkhps) == 'object' ? get_networkhps.result : get_networkhps;
          if (get_networkhps < 10000000) {
            winston.info('khs', get_networkhps);
            client.say(channel, settings.messages.networkhps.expand({networkhps: (get_networkhps/100000).toFixed(2)}));
          }
        else {
          if (get_networkhps < 1000000000) {
            winston.info('mhs', get_networkhps);
            client.say(channel, settings.messages.networmhps.expand({networkhps: (get_networkhps/1000000).toFixed(2)}));
          }
        else {
          if (get_networkhps < 10000000000) {
            winston.info('ghs', get_networkhps);
            client.say(channel, settings.messages.networghps.expand({networkhps: (get_networkhps/1000000000).toFixed(2)}));
            }
           }
          }
        });
        break;
         
      case 'balance':
        var user = from.toLowerCase();
        coin.getBalance(user, settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !balance command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          var balance = typeof(balance) == 'object' ? balance.result : balance;

          coin.getBalance(user, 0, function(err, unconfirmed_balance) {
          if(err) {
              winston.error('Error in !balance command', err);
              client.say(channel, settings.messages.balance.expand({balance: balance, name: user}));
              return;
            }
			var user = from.toLowerCase();
            var unconfirmed_balance = typeof(unconfirmed_balance) == 'object' ? unconfirmed_balance.result : unconfirmed_balance;

            client.say(channel, settings.messages.balance_unconfirmed.expand({balance: balance, name: user, unconfirmed: unconfirmed_balance - balance}));
          })
        });
        break;

      case 'withdraw':
        var match = message.match(/^.?withdraw (\S+)$/);
        if(match == null) {
          client.say(channel, 'Usage: !withdraw <' + settings.coin.full_name + ' address>');
          return;
        }
        var address = match[1];

        coin.validateAddress(address, function(err, reply) {
          if(err) {
            winston.error('Error in !withdraw command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          if(reply.isvalid) {
            coin.getBalance(from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
              if(err) {
                winston.error('Error in !withdraw command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }
              var balance = typeof(balance) == 'object' ? balance.result : balance;

              if(balance < settings.coin.min_withdraw) {
                winston.warn('%s tried to withdraw %d, but min is set to %d', from, balance, settings.coin.min_withdraw);
                client.say(channel, settings.messages.withdraw_too_small.expand({name: from, balance: balance}));
                return;
              }

              coin.sendFrom(from.toLowerCase(), address, balance - settings.coin.withdrawal_fee, function(err, reply) {
                if(err) {
                  winston.error('Error in !withdraw command', err);
                  client.say(channel, settings.messages.error.expand({name: from}));
                  return;
                }

                var values = {name: from, address: address, balance: balance, amount: balance - settings.coin.withdrawal_fee, transaction: reply}
                for(var i = 0; i < settings.messages.withdraw_success.length; i++) {
                  var msg = settings.messages.withdraw_success[i];
                  client.say(channel, msg.expand(values));
                };

                // transfer the rest (usually withdrawal fee - txfee) to bots wallet
                coin.getBalance(from.toLowerCase(), function(err, balance) {
                  if(err) {
                    winston.error('Something went wrong while transferring fees', err);
                    return;
                  }

                  var balance = typeof(balance) == 'object' ? balance.result : balance;

                  // moves the rest to bot's wallet
                  coin.move(from.toLowerCase(), settings.login.nickname.toLowerCase(), balance);
                });
              });
            });
          } else {
            winston.warn('%s tried to withdraw to an invalid address', from);
            client.say(channel, settings.messages.invalid_address.expand({address: address, name: from}));
          }
        });
        break;
    }
  });
});
