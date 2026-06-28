# The official SCF Integration List

The Stellar Foundation maintains an official list of building blocks SCF reviewers expect Integration Track submissions to leverage. The list is at:

`https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/integration-track/integration-list`

This document captures the items in the list at the time of this skill build, by category, with practical guidance for which to recommend per project profile.

## How SCF uses the list

For Integration Track submissions, SCF expects the dossier to leverage at least one item from this list. The strongest dossiers leverage three to seven items. Reviewers explicitly check the Q6 Integration Description against this list.

For Open Track submissions, the dossier can develop a net-new primitive, but the surrounding workflow (wallets, anchors) should still use items from this list.

Items NOT on the list (Fireblocks, Wirex, Elliptic, Certora) can be mentioned as supporting infrastructure, but should not be presented as Integration Track items.

## On / Off-ramping (Fiat Gateways)

These connect crypto and fiat. Recommend for any consumer-facing dossier where users need to onboard with local currency.

| Item | Integration time | Best for |
|---|---|---|
| Anchor Platform | 1+ month | Building your own anchor (issuer infrastructure for assets) |
| Bridge | 1-5 days | Multi-currency payments, Stripe-company partner |
| MoneyGram | 1+ month | Global cash-in/cash-out, emerging markets |
| Mercuryo | 1-2 weeks | Fiat-crypto on-ramp |
| BlindPay | 1-2 weeks | LATAM and global payments |
| Etherfuse | 1-2 weeks | Stablebonds backed by government bonds |
| alfredpay | unspecified | LATAM stablecoin to local banking rails |
| Abroad | 1-2 weeks | Digital wallets to local instant payment rails |

**Practical guidance:** for a French / EU consumer product, Anchor Platform plus optional Mercuryo or Bridge is the natural stack. For LATAM, Bridge plus alfredpay. For emerging markets cash usage, MoneyGram.

## DeFi: Yield Aggregators

| Item | Integration time | Best for |
|---|---|---|
| DeFindex | 1-2 weeks | Yield infrastructure for Stellar wallets and DeFi apps |

**Practical guidance:** the only listed yield aggregator. Recommend for any project that needs yield routing across multiple Stellar DeFi venues.

## DeFi: Individual Protocols

| Item | Integration time | Best for |
|---|---|---|
| Blend v2 | 1+ month | Lending pools |
| Aquarius | Under 1 day | DEX and LP pools (~$40M TVL) |
| Soroswap | 1-2 weeks | DEX aggregation |
| Stellar Broker | 1-5 days | Multi-source liquidity swap router |
| Sushiswap | coming soon | AMM |

**Practical guidance:** Soroswap and Aquarius are the most-used in winning dossiers. Blend for lending products. Stellar Broker is the alternative to Soroswap for routing.

## Cross-Chain and Interoperability

| Item | Integration time | Best for |
|---|---|---|
| Allbridge | TBD | Stablecoin bridging between EVM and non-EVM chains |
| Axelar | TBD | General-purpose cross-chain messaging |
| Near Intents | Under 1 day | Multi-chain execution layer for cross-chain payments |

**Practical guidance:** Near Intents is the smallest effort and has been picking up in recent winners (Grindy, AveForge proposals). Allbridge is the older standard, still solid.

## Payments

| Item | Integration time | Best for |
|---|---|---|
| Stellar Disbursement Platform (SDP) | 1-2 weeks | Cross-border bulk payments (SDF maintained) |

**Practical guidance:** recommend for any project that needs bulk payouts (creator economy, B2B payment infrastructure, NGO disbursements).

## Wallet Connection Layers

| Item | Integration time | Best for |
|---|---|---|
| Stellar Wallets Kit | Under 1 day | Multi-wallet connector (Freighter, Albedo, xBull, LOBSTR, Hana) |
| Freighter Connect | 1-2 weeks | Stellar's own browser extension wallet (SDF maintained) |
| Privy | Under 1 day | Embedded crypto accounts via email or social login |
| DFNS | 1-5 days | Wallets-as-a-Service with MPC custody |

**Practical guidance:** Stellar Wallets Kit is the default recommendation for any consumer-facing dossier. Privy is essential for non-crypto-native distribution (CGPs, family offices, mainstream consumers). DFNS is appropriate for institutional custody requirements.

## How to audit a dossier's Integration List usage

Standard process during a review:

1. List every Stellar tool or component named in Q6 Integration Description.
2. For each, check: is it on the official Integration List, and if not, can it be repositioned as "supporting infrastructure"?
3. Recommend additions. The strongest dossiers leverage three to seven Integration List items.
4. Recommend repositioning. If the dossier names something off-list (Fireblocks, Elliptic) as core, suggest moving it to "supporting infrastructure" or replacing with a listed alternative.

## Worked examples

### For Yield (regulated DeFi yield vault), recommended Integration List usage

7 items leveraged:
- DeFindex (yield routing)
- Blend v2 (lending pools)
- Aquarius (DEX and LP)
- Soroswap (DEX aggregation)
- Allbridge (cross-chain inflows)
- DFNS (institutional MPC custody)
- Stellar Wallets Kit (multi-wallet connector)

Supporting infrastructure (off-list): Fireblocks, Elliptic, Notabene, Certora.

### Tickie (event ticketing with secondary market), recommended

4 items leveraged:
- Stellar Wallets Kit (crypto-native fans)
- Passkey Kit (passwordless onboarding for mainstream gamers)
- Anchor Platform (EUR-to-USDC fiat ramp via CGPs)
- Allbridge (optional cross-chain for international buyers)

### Antevorta Gold (gold tokenization), recommended

3 items leveraged (mandatory):
- Stellar Wallets Kit (crypto-native investors)
- Privy (CGPs and family offices, no browser extension)
- Anchor Platform (EUR-to-USDC fiat ramp, mandatory for HNW EUR onboarding)

### Solar Braves (Stellar-native dungeon RPG), recommended

3 items leveraged:
- Stellar Wallets Kit (crypto-native gamers)
- Passkey Kit (non-crypto-native gamers)
- Privy (Web2 gamers familiar with email or social login)

### Rebond (green bond tokenization), recommended

3 items leveraged:
- Stellar Wallets Kit (retail-accredited investors)
- DFNS (optional institutional MPC custody for family offices)
- Allbridge (optional cross-chain stablecoin inflows)

## Items expected to be added to the list

The Foundation evolves the list quarterly. Items currently not on the list but rumored to be added in upcoming quarters include:
- Passkey Kit (currently a sub-component of Stellar Wallets Kit positioning).
- Native EURC anchor infrastructure.
- Additional cross-chain primitives.

When in doubt, refresh the live list URL before submitting.

## Re-verification rule

Before every Q6 Integration review, glance at the live Integration List URL to confirm items have not been added or removed. The list is the authoritative source; this document is a snapshot.
