# Codex Multi Auth Setup

A guided terminal installer for [codex-multi-auth](https://github.com/ndycode/codex-multi-auth). Run the account proxy on your own computer or an SSH server/NAS, connect Codex Desktop, and keep the proxy and an optional managed Codex CLI updated.

The wizard uses [`@clack/prompts`](https://github.com/bombshell-dev/clack). Prompts are in German; upstream account screens use the proxy's own interface. This is an independent setup helper, not an OpenAI product or a fork of the account manager.

## Start

Requires Node.js **22.19 or newer**, npm, and macOS or Linux. For a remote installation, you also need an existing SSH account with key/agent authentication. Windows users can run the server-side tools in WSL2; native Windows Desktop integration is not implemented.

```sh
git clone https://github.com/sk2andy/codex-multi-auth-setup.git
cd codex-multi-auth-setup
npm ci
npm start
```

The repository is public; cloning does not require a GitHub account. Nothing is published to npm by this project.

For the short commands below, run `npm install --global .` once. Without a global installation, use `npm start -- stats` (or another command) from the checkout. Background services use their own installed copy and do not depend on the checkout remaining open.

The wizard asks for:

1. **Local or SSH server**, with a dedicated installation folder such as a directory on NAS storage.
2. **SSH hostname, IP, or existing alias**, optional identity file and fallback destination. For example, use a LAN hostname first and a Tailscale address when away.
3. **Optional Tailscale installation.** Authentication stays with Tailscale's own app/login flow.
4. **Account selection:** sequential or hybrid. Upstream currently has no pure round-robin mode; hybrid means health/quota-aware selection, not round robin.
5. **Optional automatic updates**, check interval, and proxy release age. Default: at least **48 hours** old; configurable from 0 to 8760 hours. The same rule applies to the first installation.
6. **Optional managed Codex CLI.** Its stable releases have no additional age delay. Existing system/npm/Homebrew installations are left in place. A backed-up `~/.local/bin/codex` link is an explicit additional choice.
7. **Account onboarding**, with a choice of standard browser OAuth or device-code login. Add one or multiple accounts locally or over SSH; no callback-port forwarding required.
8. **Desktop configuration.** After a successful connection test, the wizard backs up and changes the local `openai_base_url` while preserving unrelated TOML and comments.

When prompted at the end, **fully quit Codex Desktop and reopen it**. Then send a small request. Changing only the server's hostname/IP later normally needs no Desktop restart because the local endpoint stays the same.

## How it works

Codex Desktop sends requests to a fixed address on your own computer. A small background connector forwards them to the proxy host: directly for a local installation, or through an encrypted SSH tunnel for a server/NAS installation. The SSH connection can use your LAN address or the configured Tailscale fallback.

```mermaid
flowchart LR
    subgraph Client["Your computer"]
        Desktop["Codex Desktop"]
        Connector["Local connector<br/>127.0.0.1"]
        Desktop -->|"Requests"| Connector
    end

    subgraph Host["Proxy host: same computer or SSH server / NAS"]
        Gateway["Compatibility gateway<br/>127.0.0.1"]
        Proxy["codex-multi-auth router<br/>Account selection and failover"]
        Pool[("Account pool<br/>Stored only on the proxy host")]
        Supervisor["Background supervisor<br/>Started by systemd or launchd"]
        Gateway -->|"Requests with private router key"| Proxy
        Pool -.->|"Credentials and account state"| Proxy
        Supervisor -.->|"Starts and monitors"| Proxy
    end

    Connector -->|"Local installation: loopback"| Gateway
    Connector -->|"Remote installation: SSH over LAN or Tailscale"| Gateway
    Proxy <-->|"HTTPS requests and streamed responses"| OpenAI["OpenAI / Codex backend"]
```

The gateway adds the private router key and forwards streamed responses back along the same path. The upstream router owns account selection, token refresh, and failover between eligible accounts. Sequential mode follows account order; hybrid mode considers account health and quota. Available models and account eligibility still determine which account can serve a request.

The background services keep running after the setup terminal closes, subject to the platform's login requirements described below. Account management and updates use a maintenance lock: existing requests drain, the router pauses, then it resumes after the operation. This keeps two processes from refreshing the same account tokens simultaneously. The optional update scheduler checks releases separately and applies the configured release-age delay.

### Proxy-specific settings

The underlying proxy is **[ndycode/codex-multi-auth](https://github.com/ndycode/codex-multi-auth)**. For settings beyond this installer's menu, consult its [configuration guide](https://github.com/ndycode/codex-multi-auth/blob/main/docs/configuration.md) and [command reference](https://github.com/ndycode/codex-multi-auth/blob/main/docs/reference/commands.md).

Run upstream commands through this helper so they use the correct account pool and target, whether local or over SSH:

```sh
codex-ma-setup proxy -- --help
codex-ma-setup proxy -- config explain
codex-ma-setup proxy -- <upstream-command> <arguments>
```

Use `codex-ma-setup configure` for settings owned by this installer, such as SSH addresses, account strategy, and update schedules. The helper sets the router's account directory and strategy when it starts; upstream defaults may therefore be overridden by these managed settings. Files inside `current-proxy` belong to an installed release, so source edits there do not carry over to the next update.

## Daily commands

| Command                                 | Purpose / upstream command                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `codex-ma-setup`                        | Guided menu                                                                       |
| `codex-ma-setup install`                | New local/SSH installation                                                        |
| `codex-ma-setup connect`                | Connect another computer to an existing SSH installation                          |
| `codex-ma-setup configure`              | Change SSH address/fallback/key, strategy, Tailscale, updates, or Desktop binding |
| `codex-ma-setup accounts add`           | Choose browser or device-code login; always preserves account selection           |
| `codex-ma-setup accounts list`          | `codex-multi-auth list`                                                           |
| `codex-ma-setup stats`                  | `codex-multi-auth status`                                                         |
| `codex-ma-setup accounts usage`         | `codex-multi-auth usage`                                                          |
| `codex-ma-setup accounts remove`        | Opens `codex-multi-auth login`; select account, then Delete (`D`)                 |
| `codex-ma-setup proxy -- limits --json` | Passes arguments unchanged to the official proxy CLI                              |
| `codex-ma-setup proxy -- --help`        | Official proxy command help                                                       |
| `codex-ma-setup codex -- --version`     | Run the separately managed Codex CLI on the selected target                       |
| `codex-ma-setup doctor`                 | Runtime, catalog, service, installation versions, and client connection           |
| `codex-ma-setup resume`                 | Continue interrupted onboarding without resetting accounts                        |
| `codex-ma-setup recover`                | Explicit recovery of abandoned maintenance; never restores old OAuth tokens       |

Account helpers always use the installed upstream tool and its actual account store. There is no second OAuth implementation, made-up `remove` command, or copied account-selection algorithm. The official interactive account manager owns deletion and confirmation.

Account management pauses the router for the duration of the command after current requests drain. A browser login can therefore keep the proxy paused until that login completes or is cancelled. This prevents the router and account tool from refreshing the same token concurrently. If a request cannot drain in time, the operation stops rather than interrupting it. Try again when the proxy is quiet.

See the [upstream command reference](https://github.com/ndycode/codex-multi-auth/blob/main/docs/reference/commands.md) for available arguments. Index conventions may differ between JSON and interactive commands; this helper does not translate indices.

## Automatic updates

```sh
codex-ma-setup updates enable
codex-ma-setup updates disable
codex-ma-setup updates configure
codex-ma-setup updates check
codex-ma-setup updates run
codex-ma-setup updates status
```

`configure` can install the schedule after initial setup, switch systemd/cron on Linux, and change the release delay. `run` is an explicit manual check/apply even when scheduling is disabled; it **still respects the configured release age**. `disable` removes only this installation's automatic schedule and leaves the proxy running.

Updates:

- select stable releases only; do not downgrade when a release tag moves backward;
- check package digests, archive contents, platform, and reported version;
- stage each release separately and install proxy dependencies with lifecycle scripts disabled;
- block new gateway requests while draining existing work;
- back up configurations and account state before changing selected programs;
- atomically switch the selected package and check the real model catalog;
- restore the previous **program** if verification fails, keeping current OAuth tokens;
- retain a journal for interrupted updates and delay automatic retries of the same failed version pair by 24 hours.

Routine verification does not send inference requests. An optional `updates.smokeModel` in the server's private `config.json` enables an actual inference check; this may consume account usage. Scheduled failures and deferred runs appear in `maintenance-state/status.json` and the service logs. There is no external notification integration.

The managed CLI is a complete official package, including its code-mode host and resources. Updating it does **not** replace the CLI bundled inside Codex Desktop or automatically take over an existing native app-server daemon. `doctor` reports those versions separately. Use the Desktop application's own restart/update controls when its background process is older.

## Platform and network details

| Component                      | macOS                              | Linux                                                      |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------- |
| Runtime and local connector    | User LaunchAgents; login required  | systemd user service, or explicit system service with sudo |
| Automatic updates              | LaunchAgent interval               | systemd timer or optional marked cron block                |
| Server without an active login | Not provided by a user LaunchAgent | Choose system service; alternatively enable user lingering |
| CPU architectures              | Intel / Apple Silicon              | x64 / ARM64                                                |

The SSH target needs `tar` and standard shell utilities. If an adequate Node runtime is absent, setup installs a verified Node 24 LTS package into its own directory. Installing Tailscale on Linux uses the [official installer](https://tailscale.com/install.sh) after backing up existing relevant configuration; macOS installation uses Homebrew's Tailscale cask. System package installation may request sudo. Tailscale itself is optional: ordinary LAN SSH works without it.

All proxy listeners bind to **127.0.0.1**. The connector uses strict SSH host-key verification and forwards only to the selected loopback gateway. A LAN `.local` name generally does not resolve while away; configure a Tailscale DNS/IP fallback rather than assuming multicast DNS travels through the VPN. Both destinations must identify the same installation.

Account and update commands also select a reachable SSH address before starting work. Once a command starts, a connection failure is reported without replaying that command on the other address; this prevents duplicated changes after an uncertain result.

Your SSH server must permit local forwarding to the gateway port shown by setup. On managed NAS appliances, change this through the appliance's supported configuration mechanism; this project does not overwrite SSH server policy. A restrictive server typically needs the equivalent of:

```text
Match User YOUR_SSH_USER
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:GATEWAY_PORT
Match all
```

Use the actual port from your installation. Check SSH configuration before reloading it. A server may also impose `authorized_keys` restrictions; the installer cannot override those from a client.

Tailscale fallback preserves the encrypted SSH connection. It does not expose an unauthenticated HTTP proxy to the LAN or Tailnet. Browser-origin requests and non-loopback Host headers are rejected by the compatibility gateway.

## Backups and files

Default client metadata: `~/.config/codex-multi-auth-setup/client.json`. Default server directory: `~/.local/share/codex-multi-auth-setup`. You can select a NAS storage directory instead. Use `--client-root /absolute/path` before `--` to manage a separate client profile.

| Server path                    | Contents                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| `config.json`                  | Private setup settings and gateway secret                               |
| `data/multi-auth/`             | Upstream account pool                                                   |
| `data/codex/`                  | Isolated Codex state used by upstream management commands               |
| `current-proxy`, `current-cli` | Selected package links                                                  |
| `releases/`                    | Verified, retained program versions                                     |
| `manager/`                     | Installed copy of this helper; independent of the Git checkout          |
| `backups/`                     | Timestamped installation/config/account/service snapshots and manifests |
| `maintenance-state/`           | Update status and recovery journal                                      |
| `logs/`                        | Runtime and update logs on LaunchAgent/cron deployments                 |

Every installation and configuration-changing path makes a backup first. Service changes preserve the prior unit/plist files and complete crontab; unrelated cron jobs remain intact. A failed service activation attempts to restore the previous service configuration and state. Files and backup directories containing credentials are private to the user.

Backups and old releases are retained; no automatic pruning is performed. Never blindly restore an old account file: OAuth refresh tokens may already have rotated. Normal rollback/recovery changes selected programs, not tokens.

An interrupted wizard stores a checkpoint. Run `resume`, finish account onboarding, then complete service setup. If `doctor` reports abandoned maintenance, `recover` requires confirmation, refuses a live owner, and uses the recorded recovery path. Do not delete locks while an update or login is running.

## Development

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm test
npm pack --dry-run
```

Tests use temporary homes, fake upstream processes, real loopback HTTP/streaming, and controlled fake SSH subprocesses. No test reads real OAuth pools or changes installed services. CI runs on Linux and macOS with Node 22.19 and 24. Live package staging has additionally been checked against official proxy and CLI releases; live account login still requires the user's browser.

## Scope

This helper installs and manages its own deployment. It does not automatically migrate an arbitrary existing multi-auth installation, alter NAS-wide SSH policy, update Node/nginx/OS packages on a schedule, publish credentials, or share account pools through GitHub. Use fresh device sign-ins for the new pool.

MIT licensed. Upstream `codex-multi-auth` remains separately maintained under its own license.

## Isolated account pools (local)

Pools reuse the existing supervised proxy, account manager and hybrid usage-aware
scheduler. Each pool has its own credential store, runtime, ports, services,
configuration, MCP/plugin settings and CLI history. There is **no cross-pool
fallback**. Choose **Hybrid** in each setup dialog for usage-aware switching.
Existing non-pool installations remain supported and are not migrated implicitly.

```sh
npm start -- pools create personal --seed-from /Users/you/.codex
npm start -- pools create work
npm start -- --pool personal accounts add
npm start -- --pool work accounts add
npm start -- pools list
npm start -- pools default personal
npm start -- pools run work -- "Explain this repository"
# Equivalent pool-aware CLI command:
npm start -- --pool work codex -- "Explain this repository"
npm start -- --pool work stats
npm start -- --pool work doctor
```

Pool CLI launches use a dedicated Responses provider pointed at the selected
pool's local proxy. Authentication stays with the proxy's account pool; an empty
CLI home does not require a separate ChatGPT login. These provider settings apply
only to the launched process and do not rewrite desktop configuration or auth.

Each launch prints the selected pool and proxy endpoint to stderr. Inside Codex,
`/status` identifies the provider as `codex_pool_<name>` (display name:
`Codex pool: <name>`). The launch banner shows its endpoint.
This identifies the pool, not the rotating account selected by the proxy. Existing
sessions must be restarted to pick up the label. Explicit Codex `-c` overrides
can replace launch settings; `/status` is the authoritative check in that case.

Run setup commands in a terminal. Select distinct available ports when prompted.
`pools run` uses a locally installed `codex` executable on PATH; installing the
managed CLI is optional. Do not log out or replace the desktop login. Add every
additional model account through `--pool NAME accounts add`; copying auth.json
only seeds the client login, it does not enroll accounts in the proxy store.

`--seed-from` is optional and takes a **stopped, reviewed Codex home snapshot**.
It copies config.toml, auth.json, history.jsonl, sessions, skills and plugins into
a new private pool home, never into an existing home. Symlinks are refused. Live
SQLite databases, sockets, caches and external credential/keychain stores are not
copied; this is not a complete app backup or plugin credential migration. Close
Codex before taking the snapshot. Copies are independent after creation, not
ongoing synchronization. If a seed fails, preserve/rename its partial home before
retrying; it is never silently overwritten. Do not seed personal information into
a work pool unless intended.

The default selection redirects the **existing desktop home's model endpoint**
after probing the selected pool. It preserves app auth, history and tool settings.
Restart the app afterwards. It does **not** switch desktop history/config to the
pool's CLI home: separate full environments are selected with `pools run`. Dot or
mobile only use this selection when their requests actually pass through this
local endpoint; cloud execution is not covered. Accounts within one pool share
the context/tools of its calling client, not the individual accounts' cloud histories.

Without `--pool`, management commands use the chosen default; without a default,
legacy behavior is unchanged. `install` and `connect` remain legacy commands;
create isolated pools with `pools create`. An interrupted setup can be continued
with `--pool NAME resume`. Pool state lives under the selected `--client-root` in
`pools/NAME/{client,server,codex}`. Pool creation never redirects the existing
`.codex` desktop home; choosing the default is a separate explicit command.

### Rollback

`pools default NAME` prints the desktop backup directory; keep it. To disconnect,
close the app and restore **only config.toml** from that backup (consult its
manifest for the original path). Do not restore old auth tokens over refreshed
ones. Run `pools clear-default` to clear CLI default selection; this deliberately
leaves the desktop endpoint unchanged. You can instead select another ready pool
with `pools default OTHER`. Service names are hashed from installation roots, so
pools do not replace each other's services. Disable the particular pool's services
using the existing platform service tooling before archiving its directory;
never delete a running pool or its credentials blindly.

### Interactive pool dashboard

Run `codex-ma-setup` or `codex-ma-setup dashboard` for the interactive pool menu
(`codex-ma-setup pools` is equivalent). It lists named pools and an existing
legacy installation separately. Choose a pool, then add/list/remove accounts,
open its upstream account dashboard, configure its usage-aware routing, run
diagnostics, choose it as the desktop default, or start its isolated CLI.
Interrupted setups are marked and can be resumed. Account assignment is done by
signing into the selected pool; accounts are never silently moved or copied
between credential stores. To move an account, first sign it into the destination
pool, verify it there, then remove it from the source pool if desired.
The interactive account dashboard pauses only the selected proxy until you exit.
The pool overview itself does not touch credentials or stop running services.

### Name an existing installation without moving tokens

`codex-ma-setup pools adopt work` registers the existing installation under a
pool name without relocating credentials, changing its Codex home, copying tokens
or restarting its services. Then use `codex-ma-setup pools default work` to make
it the desktop default. This is also available from the existing-installation
entry in the interactive dashboard. The adopted pool retains the original home
and history; any additional pools use their own homes. Only one name may adopt
the original installation, and an existing named pool cannot be overwritten.

### Read-only usage, bank resets and expiry times

`codex-ma-setup --pool work usage` (or `accounts usage`) reads the native Codex
usage snapshot for every account in the selected pool. `--json` returns the same
allowlisted report for scripts. The interactive pool dashboard also offers
**Usage / Bank Resets mit Ablaufzeiten (nur lesen)**.

Bank resets are the earned `rateLimitResetCredits` entries in the native protocol,
not purchased balance credits. The report shows their available count and each
provided expiry timestamp with local date, exact time and timezone. Missing,
zero and capped/partial detail lists are distinguished; absence of details does
not mean zero. Opaque credit IDs and authentication fields are not printed.
The read RPC requests detail rows explicitly. It cannot call the consume RPC,
redeem a credit, change account selection, or enable automatic redemption.
The proxy pauses briefly while native usage is read, then resumes. Expired auth
may be refreshed in the pool store without changing the desktop login.
This reader currently requires the compatible native-usage modules shipped by
the underlying proxy. Unavailable data is reported as unknown, never zero.

### Choose the account login flow

`codex-ma-setup accounts add` asks which method to use every time, including
onboarding and the pool menu. Choose **Standard browser flow** (OAuth callback)
or **Device code**. For explicit/noninteractive selection:

```sh
codex-ma-setup --pool work accounts add --browser-auth
codex-ma-setup --pool work accounts add --device-auth
```

The standard flow runs upstream `login --preserve-selection`; device login adds
`--device-auth`. With SSH, the browser must reach the callback on the proxy host;
choose device code if callback forwarding is unavailable. Cancelling the selection
does not pause the proxy or start a login.

### Choosing a pool's CLI home

Use the pool menu's **Codex-Home anzeigen / ändern**, or:

```sh
codex-ma-setup pools home work                 # show current home
codex-ma-setup pools home work isolated        # pools/work/codex
codex-ma-setup pools home work /absolute/path  # custom or existing home
```

This setting controls the local CLI home, including SSH-backed pools. It does not
move or delete the previous home, copy history/settings, change proxy accounts,
or change the Desktop default. New empty homes authenticate through the pool
proxy without a separate login. Restart existing CLI/ACP sessions to use the new
home. For an explicit settings/history snapshot, `pools create --seed-from` is
available when creating a pool; live SQLite databases must not be copied.
