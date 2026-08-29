describe('Config Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('accepts valid configuration', () => {
    process.env.NEO_NETWORK = 'mainnet';
    process.env.LOG_LEVEL = 'debug';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('rejects invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'verbose';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/LOG_LEVEL/);
    });
  });

  it.each(['abc', '0', '-1', '1.5', 'Infinity'])(
    'rejects invalid MAX_REQUESTS_PER_MINUTE value %s',
    (value) => {
      process.env.MAX_REQUESTS_PER_MINUTE = value;
      jest.isolateModules(() => {
        const { validateConfig } = require('../src/config');
        expect(() => validateConfig()).toThrow(/MAX_REQUESTS_PER_MINUTE/);
      });
    }
  );

  it.each(['0', '-1', '1.5', 'Infinity'])(
    'rejects invalid MAX_REQUESTS_PER_HOUR value %s',
    (value) => {
      process.env.MAX_REQUESTS_PER_HOUR = value;
      jest.isolateModules(() => {
        const { validateConfig } = require('../src/config');
        expect(() => validateConfig()).toThrow(/MAX_REQUESTS_PER_HOUR/);
      });
    }
  );

  it.each(['abc', '0', '-1', '1.5', 'Infinity'])(
    'rejects invalid NEO_RPC_TIMEOUT_MS value %s',
    (value) => {
      process.env.NEO_RPC_TIMEOUT_MS = value;
      jest.isolateModules(() => {
        const { validateConfig } = require('../src/config');
        expect(() => validateConfig()).toThrow(/NEO_RPC_TIMEOUT_MS/);
      });
    }
  );

  it('rejects invalid RPC URL format', () => {
    process.env.NEO_MAINNET_RPC = 'not-a-url';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_MAINNET_RPC/);
    });
  });

  it.each(['typo', 'main', 'production'])('rejects invalid NEO_NETWORK value %s', (value) => {
    process.env.NEO_NETWORK = value;
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_NETWORK/);
    });
  });

  it.each(['http://%', 'http://', 'https:// user.example']) (
    'rejects malformed RPC URL %s',
    (value) => {
      process.env.NEO_MAINNET_RPC = value;
      jest.isolateModules(() => {
        const { validateConfig } = require('../src/config');
        expect(() => validateConfig()).toThrow(/NEO_MAINNET_RPC/);
      });
    }
  );

  it('rejects RPC URLs containing embedded credentials', () => {
    process.env.NEO_MAINNET_RPC = 'https://rpc-user:rpc-password@node.example';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_MAINNET_RPC/);
    });
  });

  it('rejects plaintext RPC endpoints outside loopback by default', () => {
    process.env.NEO_TESTNET_RPC = 'http://rpc.example:20332';
    delete process.env.NEO_ALLOW_INSECURE_RPC;
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_TESTNET_RPC.*HTTPS|secure RPC/i);
    });
  });

  it('allows an explicit insecure-RPC override for private deployments', () => {
    process.env.NEO_TESTNET_RPC = 'http://rpc.example:20332';
    process.env.NEO_ALLOW_INSECURE_RPC = 'true';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each([
    'NEO_ALLOW_INSECURE_RPC',
    'N3INDEX_ENABLED',
    'EXPLORER_ACCOUNT_WATCH_ENABLED',
    'LOG_CONSOLE',
    'LOG_FILE_ENABLED',
    'RATE_LIMITING_ENABLED',
    'NEO_ENABLE_WRITES',
  ])('rejects malformed boolean setting %s', (key) => {
    process.env[key] = 'sometimes';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(new RegExp(key));
    });
  });

  it('requires an independent token when account watch requests are enabled', () => {
    process.env.EXPLORER_ACCOUNT_WATCH_ENABLED = 'true';
    delete process.env.EXPLORER_ACCOUNT_WATCH_API_TOKEN;
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/EXPLORER_ACCOUNT_WATCH_API_TOKEN/);
    });
  });

  it('accepts a dedicated account watch integration token and fixed endpoint path', () => {
    process.env.EXPLORER_ACCOUNT_WATCH_ENABLED = 'true';
    process.env.EXPLORER_ACCOUNT_WATCH_API_TOKEN =
      'account-watch-integration-token-at-least-32-bytes';
    process.env.EXPLORER_ACCOUNT_WATCH_API_URL =
      'https://www.neo3scan.com/api/account-watches';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('rejects account watch endpoints that could redirect the service token', () => {
    process.env.EXPLORER_ACCOUNT_WATCH_API_URL =
      'https://www.neo3scan.com/api/account-watches?redirect=https://attacker.example';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/EXPLORER_ACCOUNT_WATCH_API_URL/);
    });
  });

  it('rejects reuse of the MCP transport bearer for account watch authorization', () => {
    const shared = 'shared-mcp-and-watch-token-at-least-32-bytes';
    process.env.MCP_HTTP_BEARER = shared;
    process.env.EXPLORER_ACCOUNT_WATCH_API_TOKEN = shared;
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/must differ/i);
    });
  });

  it('requires fail-closed write configuration when writes are enabled', () => {
    process.env.NEO_ENABLE_WRITES = 'true';
    delete process.env.NEO_SIGNER_WIF_FILE;
    delete process.env.NEO_WRITE_STATE_DIR;
    delete process.env.NEO_MCP_REQUEST_STATE_KEY;

    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_SIGNER_WIF_FILE/);
    });
  });

  it('allows MCP-only writes without an HTTP approval key', () => {
    process.env.NEO_ENABLE_WRITES = 'true';
    process.env.NEO_SIGNER_WIF_FILE = '/run/secrets/neo-signer-wif';
    process.env.NEO_MCP_REQUEST_STATE_KEY = 'mcp-request-state-key-that-is-at-least-32-bytes';
    delete process.env.HTTP_WRITE_APPROVAL_API_KEY;

    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('requires an independent request-state signing key when writes are enabled', () => {
    process.env.NEO_ENABLE_WRITES = 'true';
    process.env.NEO_SIGNER_WIF_FILE = '/run/secrets/neo-signer-wif';
    delete process.env.NEO_MCP_REQUEST_STATE_KEY;

    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_MCP_REQUEST_STATE_KEY/);
    });
  });

  it('rejects a short request-state signing key', () => {
    process.env.NEO_ENABLE_WRITES = 'true';
    process.env.NEO_SIGNER_WIF_FILE = '/run/secrets/neo-signer-wif';
    process.env.NEO_MCP_REQUEST_STATE_KEY = 'too-short';

    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_MCP_REQUEST_STATE_KEY/);
    });
  });

  it('rejects reuse of the ordinary HTTP key for write approval', () => {
    const sharedKey = 'shared-http-key-that-is-at-least-32-bytes';
    process.env.NEO_ENABLE_WRITES = 'true';
    process.env.NEO_SIGNER_WIF_FILE = '/run/secrets/neo-signer-wif';
    process.env.NEO_MCP_REQUEST_STATE_KEY = 'independent-request-state-key-at-least-32-bytes';
    process.env.HTTP_API_KEY = sharedKey;
    process.env.HTTP_WRITE_APPROVAL_API_KEY = sharedKey;

    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/must differ/i);
    });
  });

  it.each(['not-an-ip', '127.0.0.1/64', '2001:db8::1/129', '127.0.0.1/abc'])(
    'rejects invalid HTTP_TRUSTED_PROXIES entry %s',
    (value) => {
      process.env.HTTP_TRUSTED_PROXIES = value;
      jest.isolateModules(() => {
        const { validateConfig } = require('../src/config');
        expect(() => validateConfig()).toThrow(/HTTP_TRUSTED_PROXIES/);
      });
    }
  );

  it.each(['0', '-1', '0.000000001', 'abc'])('rejects invalid transaction fee ceiling %s', (value) => {
    process.env.NEO_MAX_TRANSACTION_FEE_GAS = value;
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/NEO_MAX_TRANSACTION_FEE_GAS/);
    });
  });

  it('rejects invalid HTTP body limits', () => {
    process.env.HTTP_MAX_BODY_BYTES = '0';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/HTTP_MAX_BODY_BYTES/);
    });
  });

  it('rejects short HTTP API keys', () => {
    process.env.HTTP_API_KEY = 'too-short';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/HTTP_API_KEY/);
    });
  });

  it('rejects wildcard or non-HTTP CORS origins', () => {
    process.env.HTTP_CORS_ORIGINS = '*,file:///tmp/client';
    jest.isolateModules(() => {
      const { validateConfig } = require('../src/config');
      expect(() => validateConfig()).toThrow(/HTTP_CORS_ORIGINS/);
    });
  });
});
