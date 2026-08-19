# Changelog

## [1.3.0](https://github.com/raccordai/raccordai/compare/v1.2.0...v1.3.0) (2026-08-19)


### Features

* **casting:** name an identity once, cast it on every shot ([6165fc5](https://github.com/raccordai/raccordai/commit/6165fc575bf57cf437c3f5e1985d636eddab97ea))
* **feedback:** review notes at the playhead, bucket panel and MCP tools ([7473b80](https://github.com/raccordai/raccordai/commit/7473b80df3c32d6a6209b872d5915b817e4f12ad))
* **hygiene:** disk cleanup on delete, arm64 ffprobe ([d67cfed](https://github.com/raccordai/raccordai/commit/d67cfed7a8d5110bb808be9df2db99f38008b95d))
* **mcp:** complete the agent surface & window-free last-frame ([13060ae](https://github.com/raccordai/raccordai/commit/13060aee2c854a4214c801cc97e502a35ae21f4f))
* **mcp:** opt-in tokenless access for local clients ([17d64f4](https://github.com/raccordai/raccordai/commit/17d64f405c0efe8a3962f72f0c9fec7f3c6722d6))
* **models:** volcengine lip-sync, OmniHuman 1.5 and restored Grok ([53347c4](https://github.com/raccordai/raccordai/commit/53347c4c14cc6f7d52534a1404c8ee619fc81695))
* **niches:** outlier lenses, snapshots & packaging-first roadmap ([889d129](https://github.com/raccordai/raccordai/commit/889d129dddf27d4066e1ba87342cfaf1818977c6))
* **niches:** YouTube niche research ([13738fb](https://github.com/raccordai/raccordai/commit/13738fbc7a88573912eb9f01131681480e3d4638))
* **projects:** per-project markdown instructions ([13f88f7](https://github.com/raccordai/raccordai/commit/13f88f7716f9c814fcf7c5164ce744a21130a9bf))
* **recipes:** shot presets and design sheets ([b02ebb7](https://github.com/raccordai/raccordai/commit/b02ebb7f6e93321bed3d8a5a49ad623b255e92e4))
* **reliability:** file log, crash handlers & renderer error funnel ([829b8f7](https://github.com/raccordai/raccordai/commit/829b8f7878dd2bab1ca58bed5af40f2b3cea2fc9))
* **scenario:** the shot list builds the graph, not the assistant ([bb82b97](https://github.com/raccordai/raccordai/commit/bb82b9728e57157f38a7ff355f6895e5086a7625))
* **speech:** Native ElevenLabs TTS & multi-voice dialogue ([0a3b2e2](https://github.com/raccordai/raccordai/commit/0a3b2e255b06d8942a94f23db8d22138af3b7f0d))
* **timeline:** dynamic captions, music ducking, expanded transitions ([523e616](https://github.com/raccordai/raccordai/commit/523e616848ed171f89a50b1d22f272967a574ca3))
* **timeline:** edge-resize handles on every lane and still image slots ([7ab53ff](https://github.com/raccordai/raccordai/commit/7ab53ff78375b4e681810b5604ac0d81706abfe5))
* **timeline:** free audio placement, sticker track and export ([aa2c837](https://github.com/raccordai/raccordai/commit/aa2c83799a8f5537da882963c66788c18ad3dbce))
* **timeline:** magnetic snapping, NLE shortcuts ([e811d37](https://github.com/raccordai/raccordai/commit/e811d370a3b10ce1877e955bf1ed7714088feaf5))
* **timeline:** split/razor per-segment trim, transitions on additive ([0f9e989](https://github.com/raccordai/raccordai/commit/0f9e98948a390750355192962b77c06fb3c0a428))
* **timeline:** title track with free positioning & typography, MCP-drivable ([2278c01](https://github.com/raccordai/raccordai/commit/2278c0110a242c77cf6958a19efbe752399c229f))


### Bug Fixes

* **models:** align seedance 2 credit rates with kie.ai pricing ([71529b6](https://github.com/raccordai/raccordai/commit/71529b668dd379e15453e12201e6b3086487503c))
* **renderer:** guard matchesShortcut against undefined event.key ([c11865e](https://github.com/raccordai/raccordai/commit/c11865e2785a6511578b0c1ca3a99f6188994f97))
* **renderer:** stop surfacing benign ResizeObserver loop warnings ([2074f79](https://github.com/raccordai/raccordai/commit/2074f7927139ad4437c9f165f6ddc0cd22213e84))
* **runEngine:** upload ElevenLabs staged audio before wiring ([#74](https://github.com/raccordai/raccordai/issues/74)) ([2dcd824](https://github.com/raccordai/raccordai/commit/2dcd824504b7f213f3cd2e9a2060eeae24f6d2db))

## [1.2.0](https://github.com/raccordai/raccordai/compare/v1.1.0...v1.2.0) (2026-07-27)


### Features

* **assistant:** multiple chat threads with a new-chat button ([ca3638b](https://github.com/raccordai/raccordai/commit/ca3638b090a99b4a7e780c3edf4431cd022f9998))
* **assistant:** render markdown in the chat transcript ([468e393](https://github.com/raccordai/raccordai/commit/468e3936faaaf86135d271aee9827f33c4792e37))
* **assistant:** require approval before the assistant spends credits ([467263b](https://github.com/raccordai/raccordai/commit/467263bd7558b6de589214fbe067fb4c51717b57))
* **chat:** the assistant runs on Claude Opus 5 by default ([2ff9337](https://github.com/raccordai/raccordai/commit/2ff9337559d3f6bedc22f368c8657e140c524adc))
* **iteration:** draft mode, finalize flow & vision QC on settle ([1149a25](https://github.com/raccordai/raccordai/commit/1149a2535a4e36ae2346116370bd54f88babe95b))
* **iteration:** prompt lint, regional feedback & named checkpoints ([3365ed0](https://github.com/raccordai/raccordai/commit/3365ed08e408024292c6da2d6d22481375e559f6))
* **iteration:** variants ×N and the compare grid ([da14a57](https://github.com/raccordai/raccordai/commit/da14a57808ab77f9ade50cded17ca9ba679a6e61))
* **models:** cut between shots instead of chaining lastFrame ([3f1c9a8](https://github.com/raccordai/raccordai/commit/3f1c9a883a18bd4c9138d4b4fbaccf11149cfbd4))
* **scenario:** plan beats into shots that are legal by construction ([452629e](https://github.com/raccordai/raccordai/commit/452629eaaff4edc1c1a93604b7fa945b11ca374b))
* **ui:** shortcut registry and toggle-to-close menus ([4beb924](https://github.com/raccordai/raccordai/commit/4beb9240617668108f4f8d78617005184231dffe))


### Bug Fixes

* **chat:** an empty provider stream no longer ends the turn in silence ([283cb65](https://github.com/raccordai/raccordai/commit/283cb656bf7bf120c0cb56135a240ffb5eea6604))
* **graph:** lay out imported workflows instead of stacking them at the origin ([8d9a671](https://github.com/raccordai/raccordai/commit/8d9a671a9d7643d5dcf822718c10b9438113eb8b))

## [1.1.0](https://github.com/raccordai/raccordai/compare/v1.0.0...v1.1.0) (2026-07-25)


### Features

* **assistant:** global sidebar, unified tool registry & smart batch runs ([d2267ea](https://github.com/raccordai/raccordai/commit/d2267ea336fcdb40b75573ea678457eef1fdaf8a))
* **editor:** generation feedback layer (toasts, queue, notifications) ([900108e](https://github.com/raccordai/raccordai/commit/900108e23f8c846b50c7e13edbacef365115973f))
* **onboarding:** first-run overlay, live kie key validation ([ec8b381](https://github.com/raccordai/raccordai/commit/ec8b381ba715b674acf7e8831e327fb8b25b2605))
* **render:** rendered MP4 export ([77315da](https://github.com/raccordai/raccordai/commit/77315dacf33d857c8d77f12f7594d19ee5bb5d63))
* **video:** video-level defaults, style-at-payload, MP4 export presets ([9e4b313](https://github.com/raccordai/raccordai/commit/9e4b313bd7f9c2184751744d24afc4cd28e6e62c))


### Bug Fixes

* guard storyboard-driven shots against rendering the grid on screen ([4fe8879](https://github.com/raccordai/raccordai/commit/4fe887949bab641eb07b129b9c9e37e2a22d050a))

## [1.0.0](https://github.com/raccordai/raccordai/compare/v0.3.0...v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* remove the feature-flag system, all features enabled everywhere

### Features

* add storyboard pre-visualization ([af3e091](https://github.com/raccordai/raccordai/commit/af3e09130abc1d9a7ed103bc6ca523a384cb8643))
* project design library and video thumbnail previews ([668dfbc](https://github.com/raccordai/raccordai/commit/668dfbc750fec0af213dc0b5aedc5fe78894192d))
* remove the feature-flag system, all features enabled everywhere ([7736a19](https://github.com/raccordai/raccordai/commit/7736a19666c132054d78ad4a62a293c0b7e9d983))


### Bug Fixes

* pass secrets to the release publish workflow ([a84be9e](https://github.com/raccordai/raccordai/commit/a84be9eb485a2bf34a83c8ee84ea341bb53f2e51))
* remove CSC_IDENTITY_AUTO_DISCOVERY ([163bf3c](https://github.com/raccordai/raccordai/commit/163bf3cd87d1fab772d31d2c119773b294e579ef))

## [0.3.0](https://github.com/raccordai/raccordai/compare/v0.2.0...v0.3.0) (2026-07-19)


### Features

* attach installers to releases and enable auto-update via GitHub ([78b8b85](https://github.com/raccordai/raccordai/commit/78b8b85e8ddbfd843c94d1dd34eed0191258584f))
* sign and notarize macOS builds in CI ([0b17707](https://github.com/raccordai/raccordai/commit/0b17707584309d5d69a063437720549e12870b52))

## [0.2.0](https://github.com/raccordai/raccordai/compare/v0.1.0...v0.2.0) (2026-07-18)


### Features

* add new models ([0d211ac](https://github.com/raccordai/raccordai/commit/0d211acd42153ba12fcc25c1f21ed830ff408740))
* add seedance 2 fast and mini ([165b0b8](https://github.com/raccordai/raccordai/commit/165b0b8d1ecf187af37aab61e3c5dbc9bf4005e9))
* design recipes, credit balance display and chained-run fixes ([91c508a](https://github.com/raccordai/raccordai/commit/91c508ae208c1bc8472098cd3d693374bc635a1a))
* initial release of raccord ([0be29d6](https://github.com/raccordai/raccordai/commit/0be29d69db8ad5e3ae9ba7ef92c0999f580afd72))


### Bug Fixes

* pipeline windows and linux ([60bc43e](https://github.com/raccordai/raccordai/commit/60bc43e95c5c253f61d02816016690499297a355))
