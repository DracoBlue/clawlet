# clawlet

The pre-alpha version of a light weight personal AI assistant. It is a coding exercise for
understanding the famous [openclaw](https://github.com/openclaw/openclaw) project.

It is not fully working and absolutely far from being useful :).

## Installation

The clawlet is just a simple nodejs application, which uses a local llm and talks via telegram.

So you will need 3 things:

1. Install a local llm (macosx)

There is a script called `launch-mlx.sh` which you can use to run the local llm on port 127.0.0.1:8000. For this
it uses homebrew to install python3.11 if not available, creates a .venv for python and installs mlx-lm into
it and then installs mlx-openai-server.

```
$ ./launch-mlx.sh
```

2. Optional telegram bot support

If you want to talk to it via telegram - create a bot (see [telegram documentation on bot creation](https://core.telegram.org/bots/tutorial#obtain-your-bot-token))
and store the id of the user and the token in `.env` as follows:

```
TELEGRAM_USERINFO_ID=
TELEGRAM_BOT_TOKEN=
```

3. Install and run clawlet cli

If you want to use the published release use:

```
$ npx clawlet
```

## Development Version

If you cloned this repository run:

```
$ pnpm install
$ pnpm start 
```

## Roadmap

* features
  - [x] handle session history
  - [x] read/write files and trash in workspace folder
  - [ ] git history for workspace folder
  - [x] <AGENTS.md> support
  - [x] <SOUL.md> support
  - [x] users details at USER.md
  - [x] assistants details at IDENTITY.md
  - [x] daily memory in memory/*.md
  - [x] longterm memory in MEMORY.md
  - [ ] heartbeat crons via HEARTBEAT.md
  - [x] <SKILL.md> support (install + use and sandbox)
  - [x] permission handling for skills
  - [x] connection for api keys and credentials
  - [ ] add mcp configuration
* local llm
  - [x] support mlx locally on macosx M3++
* messaging
  - [x] chat via command line interface
  - [x] chat via telegram bot
* installation
  - [x] make available with (p)npx
* qa
  - [x] add evals via vitetest
* operating system support
  - [x] runs on macosx
  - [ ] run on windows / linux
  - [ ] an *.app for mac 
  - [ ] an .exe for windows

# License

clawlet is copyright 2026 by DracoBlue and licensed under the MIT License.
