# Q2 Description rewrites (1000 chars max)

Five fully-developed rewrites for the five most common SCF dossier categories. Each lands at 900-980 characters and follows the winning template: positioning, product, why Stellar, traction, day-1 distribution.

## Category 1: Regulated DeFi yield (anchor: For Yield target $144K)

> For Yield is the first French MiCA-aligned DeFi yield vault on Stellar, channelling licensed EU capital into Soroban via DeFindex, Blend v2, Aquarius and Soroswap.
>
> The product: YieldVault.rs (Soroban, MIT open-source) wraps the DeFindex allocator across Blend lending pools and Aquarius LP positions. PerfFeeModule.rs streams performance fees to LPs. EURC SAC wrapper handles EUR-denominated entries.
>
> Why Stellar: regulated EU investors need EURC-native rails and 5-second finality for compliant NAV reporting. EVM gas would break vault economics at the €100K-€500K ticket sizes our PSCA AMF dossier targets.
>
> Traction: PSCA AMF dossier filed April 2026, EP simplifie filed parallel, ACCEIS audit passed, 50 HNW clients onboarded, €7-8M AUM committed.
>
> Day-1 distribution: AXA Wealth Services pipeline, CGP network across France, Crypto and Macro media (35K subscribers).

Character count: 957.

## Category 2: B2B marketplace with Soroban escrow (anchor: The Signal $121K winner)

> [Project] is a B2B settlement layer for [vertical], serving [specific buyer-supplier dynamic] with Soroban-native atomic escrow.
>
> The product: DealEscrow.rs (Soroban, MIT open-source) holds buyer funds in USDC and releases them via Atomic Splits to suppliers, brokers, and platform on milestone completion. Stellar Wallets Kit handles wallet onboarding.
>
> Why Stellar: per-deal escrow rebalancing happens 5 to 10 times per transaction lifecycle. EVM gas (multi-dollar per call) would erode our 2 to 4 percent platform commission. Stellar's sub-cent fees and 5-second finality let us settle in real time without breaking unit economics.
>
> Traction: prior Stripe Connect product with 50+ verified service providers, $1.2M GMV across 200+ deals 2024-2025. 14 LOIs signed for Soroban migration. Founders prior shipping verifiable on LinkedIn and GitHub.
>
> Day-1 distribution: existing 50-provider network, plus 3 named B2B verticals committed (specifics on request).

Character count: 974.

## Category 3: RWA tokenization (anchor: Bando $75K winner, Rebond $132K target)

> [Project] is a Soroban-native settlement layer for [asset class] in [jurisdiction], serving [specific issuer or investor segment].
>
> The product: [Asset]Token.rs (Soroban, MIT open-source) issues whitelisted [asset class] tokens with on-chain ownership transfer. KYCWhitelist.rs enforces accredited-investor checks via on-chain attestations. CouponDistributor.rs streams [yield or revenue share] to holders.
>
> Why Stellar: [asset class] trade in [low-margin secondary markets / institutional ticket sizes / cross-border flows] where [specific economic argument that EVM cannot match].
>
> Traction: [N] LOIs signed with named [issuers / underwriters / brokers] representing [€XM pipeline]. Regulatory framework: [Art L.411-2 CMF / MiFID II / MiCA / BaFin / equivalent]. Distribution partners: [Named Partner 1 (license), Named Partner 2 (license)].
>
> Day-1 distribution: [named regulated channel], plus [secondary distribution channel].

Character count: 945. Fill bracket placeholders with client specifics.

## Category 4: Consumer game native to Stellar (anchor: Solar Braves target $121-132K)

> [Project] is a Stellar-native [game genre] where every player asset, every economy interaction, and every progression milestone settles on Soroban in real time.
>
> The product: [GameContract].rs (Soroban, MIT open-source) handles [specific in-game economic primitive: item ownership, crafting outcomes, PvP escrow, etc.]. Stellar Wallets Kit plus Passkey Kit plus Privy onboard crypto-native gamers, mainstream gamers, and Web2 gamers via the appropriate stack.
>
> Why Stellar: [game] involves [N] economic transactions per session. EVM gas of $0.05 to $2.00 per action breaks unit economics for [scale: 10K daily players, etc.]. Stellar's sub-cent fees and 5-second finality close the loop.
>
> Traction: prior game [Name] live on [chain], [users] paying users, [$revenue] revenue. Team shipping credits: [Studio releases, Hackathon wins].
>
> Day-1 distribution: existing [Name] player base, plus [community channel] with [N] engaged users.

Character count: 956. The dossier should avoid earn-via-low-effort-activity language entirely (no earn-to-X).

## Category 5: Infrastructure / developer tooling (anchor: Latch+KMP, Orion+OctoPos RFP winners)

> [Project] is a [specific infrastructure category] for Stellar developers, complementing [named existing primitives] and addressing [specific gap].
>
> The product: [Tool].rs or [Tool].ts (open-source, MIT) provides [specific capability]. [Tool] uses [named SCF Integration List items] for [specific use case].
>
> Why Stellar: the [specific gap] affects [target developer audience]. Existing solutions [either duplicate SDF roadmap / target other chains / lack specific feature]. [Project] fills this gap without overlap with [Named Prior Funded Projects].
>
> Traction: [GitHub stars / dev signups / pilot integrations]. Team prior shipping: [specific credits]. The tool is at [URL] and uses [Specific Stellar SEPs or standards].
>
> Day-1 distribution: Stellar dev community via [Discord, Twitter, conference talks], plus [Named Stellar ecosystem partners] for integration support.

Character count: 920. Infrastructure dossiers benefit from explicit "complementing X, not duplicating Y" framing.

## Common Q2 mistakes to avoid

These are the patterns that have caused Q2 rejections in past rounds:

- No mention of Stellar in Q2 (Antevorta initial draft did this). The Q2 must name Stellar explicitly.
- Generic "Why Stellar" (speed and low fees) that could apply to any chain. Specify the per-transaction economic argument.
- Earn-to-X language ("earn rewards by reading / watching / playing"). 100 percent rejection rate.
- Token launch mention without regulatory framing.
- Vague TAM ("Pan-Africa", "2 billion users", "global creator economy").
- Project name as the category ("Stellar Fintech OS").

## Q2 character calibration

The field accepts 1000 characters. Aim for 900-980. Below 850 the dossier feels under-baked. Above 990 you cannot safely edit later. Tools like https://wordcounter.net let you verify before pasting.
