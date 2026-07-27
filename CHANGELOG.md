# Changelog

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
