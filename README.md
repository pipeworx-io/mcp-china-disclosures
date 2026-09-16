# @pipeworx/china-disclosures

Non-SEC Chinese biotech deals and HK/STAR IPO financing — licensing agreements and
IPOs with no US-listed party, read straight out of the HKEX and CNINFO exchange
disclosure feeds. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `hkex_licensing_deals(query?, since?, until?, limit?)` — biotech/pharma
  licensing and collaboration deals disclosed by HKEX-listed companies, including
  deals with **no US-listed party at all** (e.g. a Chinese HKEX-listed biotech
  out-licensing to an Indian, Japanese, or European partner). Sourced from
  HKEXnews filings titled "License Agreement" or "Licensing Agreement".
- `hkex_ipo_filings(query?, since?, until?, limit?)` — Hong Kong IPO / listing
  financing filings — the "GLOBAL OFFERING" prospectus and formal notice every
  company files with HKEX when it lists. Not biotech-specific; filter with
  `query`.
- `cninfo_disclosure_search(query, board?, since?, until?, limit?)` — full-text
  search over CNINFO, the official disclosure feed for both Chinese A-share
  exchanges (Shenzhen + Shanghai, STAR Market included). Covers A-share-listed
  companies with **zero HK/US nexus** — the other half of the gap.

## Why this exists, and why china-pharma / pharma-deals don't already cover it

`china_licensing_deals` (china-pharma) and `pharma_licensing_deals` (pharma-deals)
are both SEC 8-K based: they see a deal only if at least one party is US-listed.
A China-to-China or China-to-Japan deal between two companies with no US listing
is real, disclosed, and structurally invisible to either tool. Demand log,
2026-09-13 scouting pass: 3+ real asks for exactly that class of deal, plus
HK/STAR biotech IPO financing.

Two more exchanges' own disclosure layers close the gap, both probed live
2026-09-13:

- **HKEX** — any Hong Kong-listed company discloses a material licensing deal or
  its own IPO under HKEX listing rules the same day, and HKEXnews' public
  title-search JSON endpoint (`titleSearchServlet.do`) serves those filings
  without a key. This is the *same endpoint* `nmpa_drug_approvals` (china-pharma)
  already uses for NMPA approvals — same trick, different title term.
- **CNINFO** (cninfo.com.cn) — the official disclosure feed for SZSE + SSE
  A-shares, STAR Market included. `hisAnnouncement/query` is a POST endpoint, no
  auth, plain browser UA — verified live returning 20,703 matches for
  `searchkey=许可` (license/licence), dated as recent as the day of the probe.

## Traps

- **HKEX `titleSearchServlet.do` ignores `from`/`to` entirely** when
  `searchType=1` and `title` is set — verified across three different date
  windows (a 9-month range, a 1-month range, and a single day in 1990) on three
  different title terms ("License Agreement", "Licensing Agreement", "Global
  Offering"): identical result set every time. It is a rolling
  most-recent-titles window, not a date-filtered query. Both HKEX tools fetch
  the unbounded window and apply `since`/`until` themselves, client-side — a
  window before the reachable range returns `found: false` with an explicit
  hint naming the actual reachable dates, never a silently-empty "nothing that
  period".
- **CNINFO's board/segment filter looks like it should be guessable and isn't.**
  An initial probe of `category=`/`plate=kcb` for STAR Market returned HTTP 200
  with the full unfiltered result set — a silent no-op, not an error. The real
  parameter, `plate=shkcp`, was found by watching the disclosure search page's
  OWN network request when its 科创板 (STAR Market) checkbox is selected in the
  browser — the same recipe china-exchange-data used for SZSE's report
  catalogs. Verified as a REAL filter, not another no-op: unfiltered
  `searchkey=许可` returns `totalAnnouncement: 20703`; `plate=shkcp` returns
  `306`, every one of them a 688xxx (STAR Market) code.

  Unfiltered vs. filtered, same search term, live 2026-09-13:

  ```
  plate=""      (all SZSE+SSE)  → totalAnnouncement: 20703
  plate="shkcp" (STAR Market)   → totalAnnouncement: 306   (all secCode 688xxx)
  ```

  Only `star` (`shkcp`) and `chinext` (`szcy`) are exposed as `board` values —
  both confirmed the same way. Other segments (main board, GEM) were not
  observed this way and are deliberately left unmapped rather than guessed;
  omit `board` to search all boards.
- **CNINFO's `seDate` range param genuinely filters server-side** (unlike
  HKEX's `from`/`to`) — confirmed by comparing a 12-day window (1 hit) against a
  disjoint historical month (0 hits) for the identical search term and board.
- **Don't translate a query before searching CNINFO.** It is a Chinese
  full-text index; searching the English translation of a Chinese term returns
  nothing, and reads as "no disclosures" rather than "wrong language" (see
  `reference_bilingual_entity_names` — never translate-then-search).
- **HKEX title search returns duplicate rows for one event.** A Global Offering
  typically produces both a "Listing Documents" row (the prospectus PDF) and an
  "Announcements and Notices" row (the formal notice) for the same listing —
  both are returned, tagged with `doc_category`, rather than silently
  deduplicated into one.

## Coverage limits, stated honestly

- `hkex_licensing_deals` / `hkex_ipo_filings`: require the Asian party to be
  **HKEX-listed** (Main Board or GEM). A private-to-private deal, or one between
  two A-share-only companies, is invisible here — use `cninfo_disclosure_search`
  for the A-share side.
- `cninfo_disclosure_search`: requires an **A-share-listed** party (Shenzhen or
  Shanghai, including STAR Market). A company listed only overseas (HK, US, or
  privately held) does not appear.
- A deal or listing with **neither** an HKEX-listed nor an A-share-listed nor an
  SEC-filing party (china-pharma / pharma-deals) is not visible to any tool in
  this catalog.
- Both HKEX tools only reach HKEXnews' current rolling title-search window
  (recently, roughly the last several weeks to a couple of months, depending on
  how common the phrase is) — see the trap above. `cninfo_disclosure_search` has
  no such limit; its `since`/`until` genuinely reach back in time.

## Auth

None. Keyless on all three tools.

## Data sources

- `hkex_licensing_deals` / `hkex_ipo_filings`:
  `https://www1.hkexnews.hk/search/titleSearchServlet.do` (HKEXnews public
  title search) and the linked filing PDFs under `https://www1.hkexnews.hk/`.
- `cninfo_disclosure_search`: `https://www.cninfo.com.cn/new/hisAnnouncement/query`
  (CNINFO's public disclosure search) and PDFs under
  `https://static.cninfo.com.cn/`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-disclosures": {
      "url": "https://gateway.pipeworx.io/china-disclosures/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-disclosures/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-disclosures": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-disclosures"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-disclosures
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Disclosures data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
