import "dotenv/config";

const config = {
  xrpl: {
    network: process.env.XRPL_NETWORK || "devnet",
    wssUrl:
      process.env.XRPL_WSS_URL ||
      "wss://s.devnet.rippletest.net:51233",
  },
  issuer: {
    address: process.env.ISSUER_ADDRESS || "",
    secret: process.env.ISSUER_SECRET || "",
  },
  server: {
    port: parseInt(process.env.PORT || "8080", 10),
    host: process.env.HOST || "localhost",
  },
};

export default config;
