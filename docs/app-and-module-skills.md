# NeoOS App and Module Skills

NeoOS exposes declarative skills as discovery metadata. An app or game declares a
skill in its signed release manifest and groups one or more capability IDs from
that same release. A skill cannot create a capability, widen a permission, sign a
transaction, or broadcast one.

## Discovery contract

- `list_apps` discovers published apps and games.
- `list_skills` discovers the skills attached to those releases and supports
  `appId` and keyword filters.
- `get_app_capabilities` returns the complete capability and skill declaration,
  including release provenance.
- `draft_app_intent` validates a user request against the declared capability
  schema and creates an unsigned review draft.

The MCP server validates catalog and manifest identity, capability parity, closed
input schemas, duplicate IDs, capability references, field limits, and release
digests before returning a skill. Invalid or divergent metadata fails closed.

## Module skills

The same `skill-manifest.v1` schema supports platform modules. Module discovery
must use a separately published, content-addressed module catalog with the same
release identity checks. Until that catalog is published, module manifests are
schema-valid source material only and are not advertised as callable MCP skills.

## Trust boundary

Skills are a routing and explanation layer. Authorization remains in the AA and
platform contract layers; eligibility remains in DID and application policy
layers. A discovered skill is therefore safe to expose to an assistant without
turning catalog metadata into authority.
