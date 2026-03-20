require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
require('@openzeppelin/hardhat-upgrades');

const {PRIVATE_KEY, GAS_PRICE} = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  networks: {
    mezotestnet: {
      url: "https://rpc.test.mezo.org",
      chainId: 31611,
      accounts: [PRIVATE_KEY]
    },
    mezomainnet: {
      url: "https://rpc-internal.mezo.org",
      chainId: 31612,
      gasPrice: +GAS_PRICE,
      accounts: [PRIVATE_KEY]
    }
  },

  etherscan: {
    apiKey: {
      'mezotestnet': 'empty',
      'mezomainnet': 'empty'
    },
    customChains: [
      {
        network: "mezotestnet",
        chainId: 31611,
        urls: {
          apiURL: "https://api.explorer.test.mezo.org/api",
          browserURL: "https://explorer.test.mezo.org"
        }
      },
      {
        network: "mezomainnet",
        chainId: 31612,
        urls: {
          apiURL: "https://api.explorer.mezo.org/api",
          browserURL: "https://explorer.mezo.org"
        }
      }
    ]
  },

  solidity: {
    version: "0.8.33",
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999
      },
      evmVersion: "london"
    }
  }
};
