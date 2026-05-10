export const TOKENS = [
  { symbol:"SOL",   name:"Solana",         color:"#9945FF", bg:"#2d1a4e", price:148.5 },
  { symbol:"USDC",  name:"USD Coin",        color:"#2775CA", bg:"#1a2a3e", price:1.0 },
  { symbol:"USDT",  name:"Tether",          color:"#26a17b", bg:"#1a3030", price:1.0 },
  { symbol:"BONK",  name:"Bonk",            color:"#f5922f", bg:"#3e2a1a", price:0.0000185 },
  { symbol:"JUP",   name:"Jupiter",         color:"#2fbd91", bg:"#1a3028", price:0.72 },
  { symbol:"RAY",   name:"Raydium",         color:"#3b8eea", bg:"#1a2a3e", price:2.15 },
  { symbol:"PYTH",  name:"Pyth Network",    color:"#a78bfa", bg:"#2a1a4e", price:0.31 },
  { symbol:"JITO",  name:"Jito",            color:"#34d399", bg:"#1a3028", price:2.95 },
  { symbol:"WIF",   name:"dogwifhat",       color:"#fbbf24", bg:"#3e2e0a", price:1.82 },
  { symbol:"WBTC",  name:"Wrapped BTC",     color:"#f7931a", bg:"#3e2a1a", price:98000 },
  { symbol:"WETH",  name:"Wrapped ETH",     color:"#627eea", bg:"#1a203e", price:2700 },
  { symbol:"DRIFT", name:"Drift Protocol",  color:"#c084fc", bg:"#2a1a3e", price:0.44 },
  { symbol:"ORCA",  name:"Orca",            color:"#2dd4bf", bg:"#1a3030", price:1.07 },
];

export const COINGECKO_IDS = {
  SOL:"solana", USDC:"usd-coin", USDT:"tether", BONK:"bonk",
  JUP:"jupiter-exchange-solana", RAY:"raydium", PYTH:"pyth-network",
  RNDR:"render-token", WIF:"dogwifhat", JITO:"jito-governance-token",
  ORCA:"orca", MSOL:"msol", GMT:"stepn", FIDA:"bonfida",
};

export const KNOWN_MINTS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol:"USDC", name:"USD Coin",      price:1.0 },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol:"USDT", name:"Tether",         price:1.0 },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol:"BONK", name:"Bonk",           price:0.0000185 },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  { symbol:"JUP",  name:"Jupiter",        price:0.72 },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol:"RAY",  name:"Raydium",        price:2.15 },
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": { symbol:"PYTH", name:"Pyth Network",   price:0.31 },
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": { symbol:"WIF",  name:"dogwifhat",      price:1.82 },
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE":  { symbol:"ORCA", name:"Orca",            price:1.07 },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So":  { symbol:"mSOL", name:"Marinade SOL",   price:168.2 },
};

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const RPC_LIST = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
];
