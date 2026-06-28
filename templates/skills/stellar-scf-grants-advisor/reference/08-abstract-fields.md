# Field-by-field guide: SCF Abstract phase

The SCF Project Abstract sheet has twelve fields plus Contact Infos. This guide walks each one, with the panel intent behind the field, the common mistakes, and the winning structure.

## Q1 Project Title

**Panel intent:** an immediate visual identifier; reviewers see this first.

**Common mistakes:**
- Generic naming with category words ("Stellar Fintech OS", "Soroban Engine"), see rejection pattern 3.
- Brand collision with major unrelated companies, see rejection pattern 4.
- Typos and formatting inconsistencies (Antevorta vs Antevorte; GRINDY.FUN vs Grindy).

**Winning structure:** specific, brandable, short, no category words, no collision. Run a Google search before submitting.

## Q2 Description (1000 chars max)

**Panel intent:** the elevator pitch. The single most important field in the Abstract.

**Required elements:**
1. The product in one sentence (what, for whom).
2. Why Stellar specifically (the economic or technical argument that other chains cannot match).
3. Traction proof of execution (numbers, named clients, recognitions).
4. Day-1 distribution (who already wants this).
5. Open-source signal if applicable.

**Common mistakes:**
- No mention of Stellar in Q2 (Antevorta did this, only mentioning Stellar in Q6).
- Vague "Why Stellar" (generic "speed and low fees") that could apply to Solana or Polygon.
- Earn-to-X language that triggers rejection pattern 10.
- Token launch mention without regulatory framing.
- Failing to surface verifiable credibility signals (recognitions, ecosystem partners).

**Winning template:**
```
[Project Name] is [the specific positioning], serving [specific customer segment].

The product: [what we build in one specific sentence].

Why Stellar: [specific economic or technical argument that EVM/Solana cannot match].

Traction: [specific numbers, specific named clients or recognitions].

Day-1 distribution: [specific channels, named partners].
```

Aim for 900-980 characters; do not leave more than 50 characters of slack.

## Q3 Project Category

**Choices:** Application, Developer Tooling, Infrastructure, Financial Protocol.

**Panel intent:** routes the dossier to the right reviewer pool.

**Guidance:**
- B2B marketplace, gaming, consumer app → Application.
- Indexer, IDE, SDK, Testing tool → Developer Tooling.
- Bridge, RPC, Oracle, Wallet → Infrastructure.
- Yield vault, lending, AMM, RWA tokenization, stablecoin → Financial Protocol.

When in doubt, pick the closest match. "Financial Protocol" is the strongest signal for regulated finance dossiers; "Application" for everything consumer-facing.

## Q4 Traction (1000 chars max)

**Panel intent:** "is this real?" The single field where you remove the "this might be vaporware" objection.

**Required elements:**
1. Live URLs (website, X, GitHub, Discord).
2. Live metrics (revenue, users, transactions, volume, MRR).
3. Named clients or partners (with signed LOIs if available; "in discussions with X" is weaker but better than nothing).
4. Regulatory milestones if applicable (filed dossiers, audits passed, certifications).
5. Industry recognitions (French Tech, ControlTick, Future of Sport laureate, Y Combinator, etc.).
6. Founder track record bullet points (verifiable past shipped products).

**Common mistakes:**
- Vanity metrics only (TikTok views without conversions).
- Vague "in discussions with X" without naming X.
- Missing verifiable URLs.
- No mention of recognitions even when they exist (Tickie had French Tech Tremplin, ControlTick, Future of Sport, all absent from their Abstract).

**Winning template:**
```
PRODUCT (live):
- URL: ...
- X: ...
- GitHub: ...
- Metric 1, Metric 2, Metric 3.

PIPELINE:
- Named client 1 (status: signed LOI / discussions).
- Named client 2.

PARTNERS (named, regulated):
- Partner 1 (credentials).
- Partner 2 (credentials).

REGULATORY:
- Framework: [Art L.411-2 CMF / MiFID II / etc.].
- Filing: [PSCA AMF, dossier filed April 2026].

TEAM (with verifiable claims):
- Founder track records summary.

RECOGNITIONS:
- French Tech / Y Combinator / similar.
```

## Q5 Website URL

**Panel intent:** verification.

**Common mistakes:**
- Missing https:// prefix.
- Trailing slash inconsistencies.
- URL points to a landing page with no real product info.

**Winning structure:** https://yourdomain.com or https://yourdomain.com/en for international audiences.

## Q6 Integration Description (1000 chars max)

**Panel intent:** "do you understand Stellar?"

**Required elements:**
1. Three-phase timeline (Months 1-2, 3-4, 5-6).
2. Specific Soroban contract names (FooBar.rs).
3. Specific SCF Integration List items named.
4. Why Stellar economic argument (sub-cent fees enable X loop that EVM gas would break).
5. Open-source commitment (MIT).
6. Supporting infrastructure clearly separated from Integration Track scope.

**Common mistakes:**
- Generic "Soroban smart contracts" without names.
- ERC-4626 mentioned on Stellar (Ethereum standard, not Stellar; see For Yield initial draft).
- EURC mentioned without StellarAssetContract (SAC) wrapper context.
- Mentioning Fireblocks, Elliptic, Certora as Integration Track items (they are not on the list).
- No phasing.
- No open-source commitment.

**Winning template:**
```
[Project] uses Soroban as the [settlement / ownership / coordination] layer for [specific use case].

Phase 1 (Months 1-2): [Contract1.rs and Contract2.rs core implementation, MIT open-source].
Phase 2 (Months 3-4): [wallet onboarding via Stellar Wallets Kit + Passkey Kit + Privy].
Phase 3 (Months 5-6): [secondary mechanisms, mainnet, ecosystem integrations].

Why Stellar: [per-transaction economic argument]. On EVM each [action] would cost [$X], breaking unit economics for [scale]. Stellar's sub-cent fees and 5-second finality close the loop.

Architecture sourced from [N] official SCF Integration List items: [Item1, Item2, Item3].

Supporting infrastructure (not Integration Track scope): [Fireblocks for X, Elliptic for Y, Certora audit covered by LaunchKit credit].
```

## Q7 Track

**Choices:** Integration Track or Open Track.

**Guidance:**
- Integration Track: dossier extends or wraps existing primitives (Stellar Wallets Kit, Privy, Anchor Platform, Soroswap, etc.). This is most dossiers.
- Open Track: dossier develops a net-new primitive not in the ecosystem (a new oracle, a new bridge architecture, a confidential-payments protocol).

When in doubt, Integration Track is the safer choice. Open Track invites more "is this really net-new?" scrutiny.

## Q8 Thumbnail (mandatory)

**Spec:** 1200x630 px PNG or JPG.

**Common mistakes:**
- Field left empty. This is sometimes single-handedly fatal: "Information Collection" status (rejection pattern 11) results.
- Generic logo with no product hint.

**Winning structure:** split-screen with the product on one side and the Stellar primitive (contract, USDC, USDC vault) on the other, with the project title and "Powered by Stellar" tagline.

If the client has an og-image.png already deployed on their website, that asset can usually be reused at the correct dimensions.

## Q9 Submitter type

**Choices:** Entity, Individual, Team of individuals.

**Guidance:**
- Entity: if a legal entity (SAS, Ltd, Corp) is registered. The panel will run KYB.
- Individual: if the project is led by a single doxxed founder without a legal entity.
- Team of individuals: if multiple founders without a registered entity.

Verify the legal entity name and registry number (e.g., RCS Paris for French SAS) and add it to Q10. The panel checks.

## Q10 Team description (2000 chars max)

**Panel intent:** "who are you?"

**Required elements per founder:**
1. Full name (no handles alone).
2. Role (CEO, COO, CTO, etc.).
3. Verifiable LinkedIn URL (https://www.linkedin.com/in/...) with the slug exactly matching their profile.
4. For CTO: GitHub URL.
5. Concrete experience (named companies, specific years, specific roles). Vague "experience in finance" is weaker than "BNP Paribas Client Advisor 2021-2022, Nordea Asset Management Fund Reporting Q1-Q3 2025".
6. Notable recognitions or achievements (IMC Quant Trading Top 0.1 percent, French Tech Tremplin laureate, Bitget COO Apprentice, Y Combinator alum).

Plus:
7. Board advisors with sector expertise (especially valuable for industries the founders don't directly come from).
8. Legal entity reference (Company SAS, RCS [number]).

**Common mistakes:**
- Founder identified only by handle (Pattern 1 trigger).
- Missing LinkedIn URLs.
- Missing GitHub for CTO.
- Vague experience claims.
- Overselling experience the LinkedIn does not back.
- Missing advisors when the team is junior.
- Missing the entity legal reference.

**Winning template:**
```
[First Last], CEO and Co-founder ([city, country])
LinkedIn: https://www.linkedin.com/in/handle/
[X / Twitter: @handle if any]
Education: [SKEMA / specific schools].
Experience: [specific named companies, specific roles, specific years].
Recognitions: [Top 0.1 percent IMC Quant Trading Competition / equivalent].
Owns at [Project]: [specific responsibilities].

[Same for each co-founder.]

Advisors (if applicable):
[Specific named advisors with sector expertise].

Company: [Project] SAS (RCS [city] [number]), headquartered in [country].
Website: [URL] | X: [URL]
```

## Q11 Number of team members

**Guidance:** the number must match the count of distinct named people in Q10.

**Common mistakes:**
- Q11 says 5 but Q10 lists only 3 (creates a "where are the other 2?" objection).

**Winning structure:** explicit alignment between Q10 and Q11. If listing 3 distinct people, write 3.

## Q12 Team Discord usernames

**Guidance:** comma-separated, no slashes (the instruction explicitly says "separated by comma"). Verify all listed usernames are active on the SCF Discord.

**Common mistakes:**
- Slash separator instead of comma (Antevorta did this).
- Listing usernames not yet active on the SCF Discord.

## Cross-field consistency checks

Before submitting:

1. Project title same in Q1 Abstract and Q1 Build (if both phases active).
2. URL with https:// prefix and same form everywhere.
3. Team count in Q11 matches distinct people in Q10.
4. Discord usernames in Q12 match the team members in Q10.
5. LOIs or named clients in Q4 match the entities referenced in Q6.
6. Twitter handle in Contact Infos matches Twitter handle on the project website.
7. Same legal entity name (Antevorta SAS) in Q9, Q10, and any other field that mentions it.
