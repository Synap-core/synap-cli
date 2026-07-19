# Comeback patterns: from rejection to award

Some teams that lost a round came back and won a later one. We have catalogued thirteen such cases. The pattern of changes is consistent. Use this document when a client is reapplying after a previous rejection.

## The thirteen comeback moves

Each move is a specific change between the rejected dossier and the winning dossier. Most successful comebacks apply two to four of these moves at once.

### Move 1: reframe the deliverable from feature-level to protocol-level

The rejected dossier described a feature ("a better swap UI"); the winner reframed it as a protocol ("a Soroban routing primitive other teams can fork").

**Why it works:** SCF wants reusable infrastructure, not closed features.

### Move 2: replace anonymous handles with full names plus LinkedIn

Pattern 1 in `03-rejection-patterns.md`. The single highest-impact fix when present.

### Move 3: right-size the budget down from $150K to $80K-$130K with sharper scope

Pattern 2. Reducing the ask and tightening the deliverable often turns a rejected dossier into a winner.

### Move 4: add a named pilot customer or integration partner before resubmitting

Move from "in discussions with X" to "signed LOI with Y, named in the dossier". Bando $75K winner did this. AveForge can do this with Stellar protocol contacts before Build phase.

### Move 5: pivot from a saturated category to an adjacent under-funded niche

If your category lost the prior round to another funded team, find a sharper sub-niche. Lend.xyz lost to Bando in RWA real estate; a reapplication should pick a different vertical or sharper geography.

### Move 6: switch Track (Open vs Integration) based on what the proposal actually is

A pure Soroban contract with no ecosystem dependencies should be Open Track. A wrap of existing primitives plus a wallet stack should be Integration Track. Picking the wrong Track gets the wrong evaluation criteria.

### Move 7: ship a Soroban testnet contract before submitting

A live testnet contract address in Q5 Code URL transforms a "we will deploy" claim into a "we are deploying" demonstration. Five to seven days of work to ship a minimal contract.

### Move 8: replace "we will validate post-grant" with documented pre-grant traction

Move from "we plan to test this" to "we tested this with 30 users last quarter and the result was X". Bando did this with their Mexican pilot.

### Move 9: explicitly acknowledge the prior gap in the abstract

Panel respects self-awareness. One sentence in Q9 Build phase: "We addressed the prior panel feedback by [specific change]." This is signal 14 in the scoring framework.

### Move 10: replace vague TAM with country + city + persona + first 100 users

Pattern 9 fix. Replace "pan-Africa" with "Lagos, Nigeria via [Named Partner], targeting [Specific Persona] for first 100 users".

### Move 11: drop overlap claims and reposition as a complement to an already-funded peer

Instead of competing with a funded project, position as the layer above or below it. For Yield does this by positioning as the regulated EU access layer on top of DeFindex, Blend, Aquarius (all prior winners).

### Move 12: add a regulatory partner name plus jurisdiction to any regulated-category submission

Pattern 8 fix. Name the framework, name the partner, show the filing.

### Move 13: publish open-source primitives so the project reads as ecosystem infrastructure, not closed SaaS

Move from "SaaS that uses Stellar" to "Soroban primitive that anyone can fork, plus a hosted instance we run".

## Worked example: a hypothetical comeback

A team submitted an Abstract last round with this profile:
- Solo dev, only known by handle "Mintro"
- $150K ask for "an event ticketing platform"
- Vague TAM ("global creator economy")
- No Soroban contract named
- No regulatory framework cited
- No LOIs

Rejected (Panel Review Failed). The team comes back six months later wanting to resubmit.

Apply moves 2, 3, 4, 7, 10, 13:

- **Move 2:** Mintro adds full name and LinkedIn, finds a doxxed co-founder with ticketing industry background.
- **Move 3:** budget drops to $121K (matched to The Signal winner), three equivalent tranches.
- **Move 4:** secured one signed LOI with a named B2B venue (300-seat theatre) for the first mainnet deal.
- **Move 7:** shipped a TicketRegistry.rs contract to testnet, address in Q5 Code URL.
- **Move 10:** replaced "global creator economy" with "Paris-region independent venues, first 5 partners via [Named Distribution Partner], targeting 100 events in Year 1".
- **Move 13:** committed to MIT open-source on TicketRegistry.rs, GitHub URL provided.

Probability went from 15 percent to 55 percent. Whether this team wins depends on additional moves (regulatory framework if they handle ticket secondary market in France, named vault partner, etc.) but the basic moves alone shifted the dossier from "almost certain rejection" to "competitive".

## The honest framing for the client

When you advise a client who is reapplying, be direct:

> *"Your previous submission triggered three of the recurring rejection patterns we've documented in our database. We can address all three before the next round. Specifically: we'll add a co-founder with a verifiable LinkedIn to fix the team accountability gap (this alone shifts your odds by roughly 15 to 25 percent), reduce the budget from $150K to $121K to align with The Signal winner ($121K in SCF #42), and replace the vague distribution plan with a named pilot in [specific city]. Three changes, six weeks of work, double-digit probability lift."*

That tone (specific, anchored on data, honest about effort) is what wins comeback engagements.
