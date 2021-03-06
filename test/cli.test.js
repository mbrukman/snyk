var _ = require('lodash');
var test = require('tap-only');
var testUtils = require('./utils');
var apiKey = '123456789';
var notAuthorizedApiKey = 'notAuthorized';
var oldkey;
var oldendpoint;
var chalk = require('chalk');
var port = process.env.PORT = process.env.SNYK_PORT = 12345;
var sinon = require('sinon');
var proxyquire = require('proxyquire');
var parse = require('url').parse;
var policy = require('snyk-policy');

process.env.SNYK_API = 'http://localhost:' + port + '/api/v1';
process.env.SNYK_HOST = 'http://localhost:' + port;
process.env.LOG_LEVEL = 0;


var server = require('./cli-server')(
  process.env.SNYK_API, apiKey, notAuthorizedApiKey
);

// ensure this is required *after* the demo server, since this will
// configure our fake configuration too
var cli = require('../cli/commands');

var before = test;
var after = test;

before('setup', function (t) {
  t.plan(3);
  cli.config('get', 'api').then(function (key) {
    oldkey = key; // just in case
    t.pass('existing user config captured');
  });

  cli.config('get', 'endpoint').then(function (key) {
    oldendpoint = key; // just in case
    t.pass('existing user endpoint captured');
  });

  server.listen(port, function () {
    t.pass('started demo server');
  });
});

before('prime config', function (t) {
  cli.config('set', 'api=' + apiKey).then(function () {
    t.pass('api token set');
  }).then(function () {
    return cli.config('unset', 'endpoint').then(function () {
      t.pass('endpoint removed');
    });
  }).catch(t.bailout).then(t.end);
});

test('cli', function (t) {
  t.plan(2);

  cli.test('semver@2').then(function (res) {
    t.fail(res);
  }).catch(function (error) {
    var res = error.message;
    var pos = res.toLowerCase().indexOf('vulnerability found');
    t.pass(res);
    t.notEqual(pos, -1, 'correctly found vulnerability: ' + res);
  });

});

test('monitor', function (t) {
  t.plan(1);

  cli.monitor().then(function (res) {
    t.pass('monitor captured');
  }).catch(function (error) {
    t.fail(error);
  });
});

test('monitor --json', function (t) {
  t.plan(3);

  cli.monitor(undefined, { json: true }).then(function (res) {
    res = JSON.parse(res);

    if (_.isObject(res)) {
      t.pass('monitor outputed JSON');
    } else {
      t.fail('Failed parsing monitor JSON output');
    }

    var keyList = [ 'packageManager', 'manageUrl' ];

    keyList.forEach(k => {
      !_.get(res, `${k}`) ? t.fail(`${k} not found`) :
        t.pass(`${k} found`);
    });
  }).catch(function (error) {
    t.fail(error);
  });
});

test('multiple test arguments', function (t) {
  t.plan(1);

  cli.test('semver@2', 'jsbin@3.11.23').then(function (res) {
    t.fail(res);
  }).catch(function (error) {
    var res = error.message;
    var lastLine = res.trim().split('\n').pop();
    t.equals(lastLine.indexOf('Tested 2 projects'), 0, 'successfully tested 2 projects');
  });
});

test('snyk ignore - all options', function (t) {
  t.plan(1);
  var fullPolicy = {ID: [
    {'*': {
      reason: 'REASON',
      expires: new Date('2017-10-07T00:00:00.000Z'), },
    },
  ],
                   };
  var dir = testUtils.tmpdir();
  cli.ignore({
    id: 'ID',
    reason: 'REASON',
    expiry: new Date('2017-10-07'),
    'policy-path': dir,
  }).catch((err) => t.throws(err, 'ignore should succeed'))
    .then(() => policy.load(dir))
    .then(pol => {
      t.deepEquals(pol.ignore, fullPolicy, 'policy written correctly');
    });
});

test('snyk ignore - no ID', function (t) {
  t.plan(1);
  var dir = testUtils.tmpdir();
  cli.ignore({
    reason: 'REASON',
    expiry: new Date('2017-10-07'),
    'policy-path': dir,
  }).then(function (res) {
    t.fail('should not succeed with missing ID');
  }).catch(function (e) {
    var errors = require('../lib/error');
    var message = chalk.stripColor(errors.message(e));
    t.equal(message.toLowerCase().indexOf('id is a required field'), 0,
            'captured failed ignore (no --id given)');
  });
});

test('snyk ignore - default options', function (t) {
  t.plan(3);
  var dir = testUtils.tmpdir();
  cli.ignore({
    id: 'ID3',
    'policy-path': dir,
  }).catch(() => t.fail('ignore should succeed'))
    .then(() => policy.load(dir))
    .then(pol => {
      t.true(pol.ignore.ID3, 'policy ID written correctly');
      t.is(pol.ignore.ID3[0]['*'].reason, 'None Given',
           'policy (default) reason written correctly');
      var expiryFromNow = pol.ignore.ID3[0]['*'].expires - Date.now();
      // not more than 30 days ahead, not less than (30 days - 1 minute)
      t.true(expiryFromNow <= 30 * 24 * 60 * 60 * 1000 &&
             expiryFromNow >= 30 * 24 * 59 * 60 * 1000,
             'policy (default) expiry wirtten correctly');
    });
});

test('snyk ignore - not authorized', function (t) {
  t.plan(1);
  var dir = testUtils.tmpdir();
  cli.config('set', 'api=' + notAuthorizedApiKey)
    .then(function () {
      return cli.ignore({
        id: 'ID3',
        'policy-path': dir,
      });
    })
    .catch((err) => t.throws(err, 'ignore should succeed'))
    .then(() => policy.load(dir))
    .catch((err) => t.pass('no policy file saved'));
});

test('test without authentication', function (t) {
  t.plan(1);
  return cli.config('unset', 'api').then(function () {
    return cli.test('semver@2');
  }).then(function (res) {
    t.fail('test should not pass if not authenticated');
  }).catch(function (error) {
    t.equals(error.code, 'NO_API_TOKEN', 'test requires authentication');
  })
  .then(function () {
    return cli.config('set', 'api=' + apiKey);
  });
});

test('auth via key', function (t) {
  t.plan(1);

  cli.auth(apiKey).then(function (res) {
    t.notEqual(res.toLowerCase().indexOf('ready'), -1, 'snyk auth worked');
  }).catch(t.threw);
});

test('auth via invalid key', function (t) {
  t.plan(1);

  var errors = require('../lib/error');

  cli.auth('_____________').then(function (res) {
    t.fail('auth should not succeed: ' + res);
  }).catch(function (e) {
    var message = chalk.stripColor(errors.message(e));
    t.equal(message.toLowerCase().indexOf('authentication failed'), 0, 'captured failed auth');
  });
});

test('auth via github', function (t) {
  var tokenRequest = null;

  var openSpy = sinon.spy(function (url) {
    tokenRequest = parse(url);
    tokenRequest.token = tokenRequest.query.split('=').pop();
  });

  var auth = proxyquire('../cli/commands/auth', {
    open: openSpy,
    '../../lib/is-ci': false,
  });

  var unhook = testUtils.silenceLog();

  auth().then(function (res) {
    t.notEqual(res.toLowerCase().indexOf('ready'), -1, 'snyk auth worked');
  }).catch(t.threw).then(function () {
    unhook();
    t.end();
  });
});

after('teardown', function (t) {
  t.plan(4);

  delete process.env.SNYK_API;
  delete process.env.SNYK_HOST;
  delete process.env.SNYK_PORT;
  t.notOk(process.env.SNYK_PORT, 'fake env values cleared');

  server.close(function () {
    t.pass('server shutdown');
    var key = 'set';
    var value = 'api=' + oldkey;
    if (!oldkey) {
      key = 'unset';
      value = 'api';
    }
    cli.config(key, value).then(function () {
      t.pass('user config restored');
      if (oldendpoint) {
        cli.config('endpoint', oldendpoint).then(function () {
          t.pass('user endpoint restored');
          t.end();
        });
      } else {
        t.pass('no endpoint');
        t.end();
      }
    });


  });
});
