var fs = require('fs'),
    yaml = require('js-yaml');

var settings = yaml.load(fs.readFileSync('./config/config.yml', 'utf-8'));

if (settings.urlget.enabled) {
    exports.filter = function(from, channel, message) {
        if (message.match(urlRE) && channel.match(settings.urlget.channels)) {
            return 1;
        } else {
            return 0;
        }

    };
    exports.action = function(from, channel, message, client) {
        var winston = require('winston');
        var user = from.toLowerCase();
        var url = require('url');
        var request = require('request');
        urlMatch = urlRE.exec(message);
        if (!(url.parse(urlMatch[0]).protocol)) {
            urlStr = 'http://' + urlMatch[0];
        } else {
            urlStr = urlMatch[0];
        }
        request(urlStr, function(error, response, body) {
            if (!error && response.statusCode == 200 && response.headers['content-type'].indexOf('text/html') > -1) {
                var cheerio = require('cheerio');
                var $ = cheerio.load(body);
                if ($('title').text()) {
                    client.say(settings.urlget.channels, trim($('title').text()));
                }
            } else {
                winston.info('URL Not found or timed out');
            }
        });
    };

    var urlRE = new RegExp('(http[s]?:\\/\\/(www\\.)?|ftp:\\/\\/(www\\.)?|www\\.){1}([0-9A-Za-z-\\.@:%_\+~#=]+)+((\\.[a-zA-Z]{2,3})+)(/(.)*)?(\\?(.)*)?');

    function trim(someText) {
        someText = someText.replace(/(\r\n|\n|\r)/gm, ' ');
        someText = someText.replace(/\s+/g, ' ');
        return someText;
    }
} else {
    return;
}
