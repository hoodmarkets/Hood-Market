# Hood Market

Public contracts, API, and docs for [hood.markets](https://hood.markets) on **Robinhood Chain (4663)**.

- **Website:** [hood.markets](https://hood.markets)
- **API:** [api.hood.markets](https://api.hood.markets)
- **Bankr skill:** [hoodmarkets/Hood-Market-Skill](https://github.com/hoodmarkets/Hood-Market-Skill)

## Layout

| Path | Description |
|------|-------------|
| [`contracts/`](contracts/) | Foundry — HoodMarkets V3 (+ related protocol) |
| [`api/`](api/) | Node/Express launcher & agent API |
| [`docs/`](docs/) | Deploy notes, V3 reference, SDK & agent docs |

## HoodMarkets V3 (default launch)

| Contract | Address |
|----------|---------|
| Factory | `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` |
| Vault | `0x856c6997A86752fB3E6A494AB93107B7A371A57f` |
| LP locker | `0x23a1c52F4E93B0283d12CC16c29Df119803E8745` |
| Fraction deployer | `0x40A19d561b3200A2C9E1014248FcEB724c450692` |
| Platform 5% | `0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98` |

See [`contracts/deployed-hoodmarkets-v3-mainnet.json`](contracts/deployed-hoodmarkets-v3-mainnet.json) and [`docs/HOODMARKETS_V3.md`](docs/HOODMARKETS_V3.md).

## Docs

- [V3 overview](docs/HOODMARKETS_V3.md)
- [Setup](docs/HOOD_MARKETS_SETUP.md)
- [Robinhood deploy](docs/ROBINHOOD_DEPLOY.md)
- [SDK](docs/sdk.md)
- [Agent](docs/agent.md)

## Contracts (Foundry)

```bash
cd contracts
forge install
forge build
forge test
```

## API

```bash
cd api
npm install
# configure env from api/README.md — never commit secrets
npm run build
```

## License

See [`contracts/LICENSE`](contracts/LICENSE).
