'use strict';
var chai = require('chai');
var sinon = require('sinon');
var chaiAsPromised = require('chai-as-promised');
var fetchMock = require('fetch-mock');

chai.use(chaiAsPromised);

// Many of these are "functional" tests that are run using Karma, and
// so "unit" tests from the browser perspective (not including browser interaction).
describe('Authorization', function() {
  const promiseCredential = Promise.resolve({
    key: {
      kid: "20171005",
      kty: "kty",
    },
    access_token: "access_token"
  });

  let sandbox;
  beforeEach(function() {
    sandbox = sinon.sandbox.create();
  });

  afterEach(function() {
    sandbox.verifyAndRestore();
    browser.flush();
  });

  it('should define syncKinto', function() {
    chai.expect(syncKinto).not.eql(undefined);
  });

  describe('401s', function() {
    const client = new Kinto();

    let credentials;
    beforeEach(function() {
      fetchMock.mock('*', {
        status: 401,
        body: "outh",
        headers: {"Content-Type": "application/json"},
      });
      credentials = {
        get: sinon.mock().returns(promiseCredential),
        clear: sinon.mock()
      };
    });

    afterEach(fetchMock.restore);

    it('should respond to 401s by deleting the token', function() {
      return syncKinto(client, credentials).then(() => {
        chai.assert(credentials.clear.calledOnce);
      });
    });

    it('should not reject the promise', function() {
      return chai.expect(syncKinto(client, credentials)).fulfilled;
    });
  });

  describe("remote transformer", function() {
    const kid = 20171005;
    const key = {kid: kid, kty: "kty"};
    it("should return whatever decrypt returns", function() {
      const decryptedResult = { content: [{ insert: "Test message" }] };
      const decryptMock = sandbox.stub(global, 'decrypt');
      decryptMock.returns(decryptedResult);
      chai.expect(new JWETransformer(key).decode({content: "encrypted content", kid: kid})).eventually.eql({
        content: [{insert: "Test message"}],
      });
    });

    it("should throw if kid is different", function() {
      chai.expect(new JWETransformer(key).decode({content: "encrypted content", kid: 20171001})).rejectedWith(ServerKeyOlderError);
    });

    it("should be backwards compatible with the old style of Kinto record", function() {
      const oldRecordStyle = [
        { insert: "Test message" },
      ];
      const decryptMock = sandbox.stub(global, 'decrypt');
      decryptMock.returns(oldRecordStyle);
      chai.expect(new JWETransformer(key).decode({content: "encrypted content", kid: kid})).eventually.eql({
        content: [{insert: "Test message"}],
      });
    });
  });

  describe('syncKinto', function() {
    let client, collection, credentials;
    beforeEach(() => {
      // We don't try to cover every single scenario where a conflict
      // is possible, since kinto.js already has a set of tests for
      // that. Instead, we just cover the easiest possible scenario
      // that generates a conflict (pulling the same record ID from
      // the server) and assume that kinto.js will treat other
      // conflicts comparably.
      fetchMock.mock('end:/v1/', {
        settings: {
          batch_max_requests: 25,
          readonly: false
        }
      });

      fetchMock.mock(new RegExp('/v1/buckets/default/collections/notes/records\\?_sort=-last_modified$'), {
        data: [{
          id: "singleNote",
          content: "encrypted content",
          kid: "20171005",
          last_modified: 1234,
        }]
      });

      sandbox.stub(global, 'decrypt').resolves({
        id: "singleNote",
        content: {ops: [{insert: "Hi there"}]},
      });

      // sync() tries to gather local changes, even when a conflict
      // has already been detected.
      sandbox.stub(global, 'encrypt').resolves("encrypted local");

      credentials = {
        get: sinon.mock().returns(promiseCredential),
        clear: sinon.mock()
      };

      client = new Kinto({remote: 'https://example.com/v1', bucket: 'default'});
      collection = client.collection('notes', {
        idSchema: notesIdSchema
      });
      return collection.upsert({id: "singleNote", content: {ops: [{insert: "Local"}]}});
    });

    afterEach(fetchMock.restore);

    it('should handle a conflict', () => {
      return syncKinto(client, credentials)
        .then(() => collection.getAny('singleNote'))
        .then(result => {
          chai.expect(result.data.content).eql(
            {ops: [
              {insert: "Hi there"},
              {insert: "\n====== On this computer: ======\n\n"},
              {insert: "Local"},
            ]}
          );
        });
    });
  });

  describe('loadKinto', function() {
    let collection, client;
    beforeEach(() => {
      collection = {
        getAny: sandbox.stub(),
      };
      client = {
        collection: sandbox.stub().returns(collection)
      };
    });

    it('should fire a kinto-loaded message even if nothing in kinto', () => {
      const syncKinto = sandbox.stub(global, 'syncKinto').resolves(undefined);
      collection.getAny.resolves(undefined);
      return loadFromKinto(client, undefined)
        .then(() => {
          chai.assert(browser.runtime.sendMessage.calledOnce);
          chai.expect(browser.runtime.sendMessage.getCall(0).args[0]).eql({
            action: 'kinto-loaded',
            data: null,
            last_modified: null,
          });
        });
    });

    it('should not fail if syncKinto rejects', () => {
      const syncKinto = sandbox.stub(global, 'syncKinto').rejects('server busy playing Minesweeper');
      collection.getAny.resolves({data: {last_modified: 'abc', content: 'def'}});
      return loadFromKinto(client, undefined)
        .then(() => {
          chai.assert(browser.runtime.sendMessage.calledOnce);
          chai.expect(browser.runtime.sendMessage.getCall(0).args[0]).eql({
            action: 'kinto-loaded',
            data: 'def',
            last_modified: 'abc',
          });
        });
    });
  });

  describe('saveToKinto', function() {
    let collection, client;
    beforeEach(() => {
      collection = {
        upsert: sandbox.stub().resolves(undefined),
        getAny: sandbox.stub(),
      };
      client = {
        collection: sandbox.stub().returns(collection)
      };
    });

    it('should not fail if syncKinto rejects', () => {
      this.timeout(5000);
      const syncKinto = sandbox.stub(global, 'syncKinto').rejects('server busy playing Minesweeper');
      collection.getAny.resolves({data: {last_modified: 'abc', content: 'def'}});
      return saveToKinto(client, undefined, 'imaginary content')
        .then(() => {
          chai.assert(browser.runtime.sendMessage.calledThrice);
          chai.expect(browser.runtime.sendMessage.getCall(0).args[0]).eql('notes@mozilla.com');
          chai.expect(browser.runtime.sendMessage.getCall(0).args[1]).eql({
            action: 'text-editing',
          });
          chai.expect(browser.runtime.sendMessage.getCall(1).args[0]).eql('notes@mozilla.com');
          chai.expect(browser.runtime.sendMessage.getCall(1).args[1]).eql({
            action: 'text-saved',
          });
          chai.expect(browser.runtime.sendMessage.getCall(2).args[0]).eql('notes@mozilla.com');
          chai.expect(browser.runtime.sendMessage.getCall(2).args[1]).eql({
            action: 'text-synced',
            last_modified: 'abc',
          });
        });
    });
  });
});