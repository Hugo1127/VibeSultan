# Sultan IL2CPP Binding Map

Strongly-typed Observer bindings confirmed from Steam interop (`Game.dll` / `Core.dll` / `Common.dll`).

## Boot / application

| API | Assembly | Notes |
| --- | --- | --- |
| `GameApplication.InitDone` | Core | Wait before load/start |
| `GameApplication.player` | Core | `Common.Player` |
| `GameApplication.global` | Core | `Common.Global` |
| `Global.inGame` | Common | Continue vs new game |
| `LoadController.LoadNewGame(int id)` | Core | `start_new_game` |
| `LoadController.LoadRound(int round, bool begin=true)` | Core | `continue_game` |
| `LoadController.NeedNewInitId` / `NeedLoadRound` | Core | Defaults when args omitted |
| `LoadController.ReloadStart()` | Core | Return to start |

## Controllers

| API | Assembly | Notes |
| --- | --- | --- |
| `GameController.Inst` | Game | **Not** `Instance` |
| `GameController.OnNextRound()` | Game | `next_round` |
| `GameController.OnPrevRound()` | Game | `prev_round` (gated by `round > max(min_round,1)`) |
| `GameController.SelectCard(Card)` | Game | `select_card` |
| `GameController.DoIThink()` / `CanShowIThink()` | Game | `inspect_card` (dossier / help only) |
| `ThinkController.AddCard` / `OnDrop` / `ThinkOverSelect` + `Player.ithink_card` / `GameController.DragCard` | Game | `think_card` (俺寻思 gameplay; may spawn map events) |
| `ThinkController.ThinkRite` / meta rite id `5000002` | Game | Temporary 「俺寻思」 ritual; real event appears after meta panel closes |
| `GameController.GetViewRites()` / `MapController.GetViewRites(Player.rites)` | Game | Visible map rites for `/scene` |
| `GameController.hand` `CardController`s | Game | Active on-screen hand widgets |
| `GameController.cardInfos` | Game | Card info detail panels (hand fallback only) |
| `GameController.optionController` | Game | Story/event options |
| `GameController.confirmController` | Game | Confirm dialogs |
| `GameController.ritePanel` | Game | Type is `RitePanelShowController` |
| `GameController.difficultyPanelController` | Game | Difficulty UI |
| `GameController.game_over` | Game | Terminal flag |

## Option / confirm / difficulty / story

| API | Notes |
| --- | --- |
| `OptionController.CurrentOptionIndex` | Set then confirm |
| `OptionController.SelectOption()` / `OnConfirm()` | `select_event_option` / `continue` |
| `ConfirmController.OnConfirm()` | `continue` |
| `PromptController.OnConfirm()` / `Content` | Intro/tip overlay; `phase=prompt` |
| `PromptChangeNameController.OnConfirm()` / `Input` | Rename overlay; keep default name via `continue`; `phase=change_name` |
| `WizardController.OnConfirm()` | Wizard overlay; `phase=wizard` |
| `OverlayScanner` | Generic scan of GameController PanelBase/Prompt panels → `values.overlays` |
| `DifficultyPanelController.CurrentSelect` / `OnConfirm()` | `select_difficulty` |
| `GameController.ShowSudanBox(bool)` | Fallback dismiss when `sudan_box_show` |

## Rite panel

| API | Notes |
| --- | --- |
| `RitePanelShowController.Current` | Current `Rite` |
| `RitePanelShowController.Slots` | `List<CardSlotController>` |
| `RitePanelShowController.TryUpdateCard(int, Card)` / `SetCard` | `place_card_on_rite` |
| `RitePanelShowController.CheckConfirm()` / `OnConfirm()` | `start_rite` |
| `RitePanelShowController.RemoveSlotCard()` | Fallback remove |
| `CardSlotController.Index` / `Current` / `RecoveryCard()` | Slot occupancy / remove |
| `CardSlotController.Slot` (`RiteNode.Slot`) | `text` / `condition` / `is_key` / `is_empty` → `/state.currentRite.slots` + `semantic:rite_slot_<i>` |

## Runtime state (`Player` / `Card` / `Rite`)

| Field | Notes |
| --- | --- |
| `Player.round` / `min_round` | day/turn; rewind floor |
| `Player.cards` / `rites` / `counter` / `global_counter_cacher` | Runtime facts |
| `Player.success` / `game_over` | Terminal authority |
| `Player.over_reason` | Diagnostic only (`int.MinValue` = unset) |
| `Player.BagIndex` | Allocator cursor, not visible-hand id |
| `Card.uid/id/bag/bagpos/life/count/Rare/Type/custom_name` | Card DTO |
| `Rite.uid/id/start/life/cards/is_show/custom_name` | Rite DTO |

## Observer action ops

| op | Binding |
| --- | --- |
| `start_new_game` | `LoadController.LoadNewGame` |
| `continue_game` | `LoadController.LoadRound` |
| `continue` | Confirm / Option / Difficulty / StoryNotify / ready rite |
| `open_daily_news` | Read-only against open `StoryNotifyController` (summarize then `continue`). **Never** clicks `GameController.StoryEntry`（一千零一夜） or `QuestEnter`（成就） |
| `select_difficulty` | `DifficultyPanelController` |
| `select_event_option` | `OptionController` index + confirm |
| `select_card` | `GameController.SelectCard` |
| `inspect_card` | set `Player.ithink_card` then `DoIThink` when available (help/dossier; does **not** create map events); while rite panel open, also accepts filled `currentRite` slot `cardUid` and returns catalog `cardSummary` even if IThink is unavailable |
| `think_card` | gameplay drop into 俺寻思: `ithink_card` + `DragCard`/`CurrentDrag` + `ThinkController.AddCard` (fallback `OnDrop`) + `ThinkOverSelect`; closes meta rite `5000002` panel when open; success = new rite(s) and/or think slot holding the card. Params: `uid` (hand/inventory/current Sudan). Main screen only (no blocking overlay / open rite panel) |
| `continue` on `rite_result` / gray Next | Prefer `SudanBreakerNewController.OnPointerClick()` (Sudan-card break confirm/play; often needs **2** continues), then `RiteResultPanelController.OnPointerClick`; `OnNext` only when Next interactable |
| `continue` on Sudan break reveal | Same: `SudanBreakerNewController.OnPointerClick()` — IsUiActive/ClickPromise may stay false while clicks still work (see recording `manual-20260727-101858-907`) |
| `place_card_on_rite` | `TryUpdateCard` after `IsCardSatisified`; optional `count` / auto `costMin` → `CardController.CardSplit` for stackable items (金币) before place; slot requirements from `currentRite.slots` |
| `equip_item` | `characterController.CardEquip(itemController)`; params `characterUid`+`itemUid`; validates owned char/follower, `装备` tag, slot compatibility; rejects occupied same slot (must `unequip_item` first); success verified via runtime `Card.equips` |
| `unequip_item` | `itemController.CanRemoveFromSlot` then `RemoveFromSlot`; params `itemUid` (+ optional `characterUid`); success verified via runtime `Card.equips` |
| `remove_card_from_rite` | slot `RecoveryCard` / `RemoveSlotCard` |
| `start_rite` | `CheckConfirm` then `OnConfirm` |
| `open_rite` | visible `RiteController.OnSubmit` from visible map rites |
| `next_round` | `GameController.OnNextRound` |
| `prev_round` | `GameController.OnPrevRound` when `round > max(min_round, 1)` |

Character cards project `equipSlotTypes` (runtime `equip_slots` with catalog fallback), `equipped[]` (runtime `Card.equips`, each row merges catalog title/text/tags + runtime tags, plus `attrBonus`), `equipBonus` (sum of equipped attr bonuses), and character `tags` (catalog + runtime). Catalog item tag `已装备` is **not** ownership authority. Scene exposes concrete `semantic:equip_{characterUid}_{itemUid}` / `semantic:unequip_{characterUid}_{itemUid}` when main screen hand widgets are visible and no rite/modal blocks.

## Phase mapping

| Scene / UI | `screen.phase` |
| --- | --- |
| StartScene | `boot` (`screen.id=startscene`) |
| Difficulty panel active | `difficulty` |
| `PromptController` intro/tip | `prompt` (+ `values.overlays`, `blockingOverlay`) |
| `WizardController` | `wizard` |
| Option / story notify | `story` |
| Confirm dialog | `confirm` |
| Rite panel active | `rite` |
| In-game desktop | `play` |
| `success` / `game_over` | `terminal` |

`TypeProbe` remains diagnostic-only and filters to Game/Core/Common assemblies.

## Semantic UI observer

`GET /scene` is the agent's authoritative description of the current UI. It returns:

- `snapshotVersion` for optimistic concurrency control.
- `scene` (`id`, `phase`, `modal`, `blocking`) and the current `instruction`.
- A stable, sorted `elements` list with roles, labels, state, hierarchy and screen bounds.
- An `affordances` whitelist. Generic clicks are exposed only as `action=click`; typed
  interactions carry `mapsToOp` and parameters.
- Capture duration, scanned-node count, truncation and other diagnostics.

When a blocking modal is present, `/scene` is foreground-only: background elements and
disabled/background affordances are omitted rather than merely marked blocked. The current
instruction, modal-local controls and enabled typed semantic targets remain visible.

The scanner starts at active known overlays and `GameController`, traverses active children
to a bounded depth, and extracts TextMeshPro/legacy text, buttons, toggles and TMP inputs.
It does not scan all Unity objects every frame. `StateHub` refreshes and caches snapshots at
most on its normal 0.5 second state cadence or on an explicit request.

Element IDs use a normalized hash of `scene + Transform hierarchy path + semantic role`.
Unity instance IDs are diagnostic only. Known virtual targets use a readable
`semantic:<target>` ID. This keeps IDs stable across observations while avoiding stale
runtime-object references.

Current semantic adapters:

- Story options map to `select_event_option` with `optionIndex`.
- The metal Sudan box maps to `draw_sudan_card`.
- BeginGuide contributes the blocking modal, instruction and preferred typed operation.
  Controls inside the guide modal remain available; controls behind it are blocked.
- `WizardController` is classified dynamically: two or more active interactable buttons
  make it a foreground `wizard_choice` modal. Its labeled buttons are exposed through
  `click_element`; generic `continue` and background Sudan actions are suppressed.
- Main play screen exposes stable `semantic:main_*` controls (draw cards, achievements,
  stats, history, I think, bag tiers, sort, prev/next day) plus visible `semantic:hand_<uid>`
  and `semantic:map_rite_<uid>` nodes.
- Visible hand cards come from active `CardController` widgets under
  `GameController.hand` (`semantic:hand_<uid>` → `select_card`). `card.bag == 0` is
  inventory only and must not be dumped into `/scene`. Hand telemetry/action parameters
  expose `rare` plus `tier` (`1=石, 2=铜, 3=银, 4=金`).
- Visible map nodes come from `GetVisibleMapRites()` (`GameController.GetViewRites()`
  with `MapController.GetViewRites(Player.rites)` fallback) as `semantic:map_rite_<uid>`
  → `open_rite`.
- Top prestige strip uses TMP labels plus counter ids
  `7100001..7100006` (善名/恶名/权势/侠名/灵视/金骰); execution day is a Sudan-card
  deadline countdown `remaining/initLife` (day 1 => `7/7`, not `round/initLife`).
- `prev_round` / `next_round` are typed only; the PrevRound button never calls
  `OnPrevRound()` through a bare runtime click. Round 1 always returns
  `no_previous_round`. Failure game-over (`game_over && !success`) still allows
  `prev_round`; victory endings do not. Terminal screens also expose
  `start_new_game` so the agent can restart when rewind is unavailable.
- Card/rite display names resolve from `StreamingAssets/config` via `ConfigCatalog`.
- Open rite slots expose `requiredRare` / `requiredTier` when condition text is
  parseable. Filled slots expose a complete compact `cardSummary`, including
  `rare`, `tier`, `life`, and a stable non-zero `tags` map. Runtime tags overlay the
  catalog fallback (they must not wipe it), and English core attrs normalize to Chinese
  keys (`wisdom` → `智慧`). These include built-in NPC/story cards, are available without
  `inspect_card`, and are persisted into card/event entity memory.
- Standard Unity buttons and toggles receive safe in-process click handlers.
- Rite and card operations remain typed actions because they require runtime UID/slot data.

`click_element` requires both `elementId` and the exact `snapshotVersion`. The per-snapshot
registry rejects stale, missing, hidden, disabled or modal-blocked targets. It invokes a
known typed adapter first, then a standard Button/Toggle handler. Descendant buttons on
custom controls (including the Sudan box) are invoked before pointer-handler fallbacks.
Arbitrary screen-coordinate clicks are intentionally unsupported.

Typed actions use the same foreground-modal gate. In particular, an active Sudan box behind
the difficulty panel does not expose or accept `draw_sudan_card`; difficulty must be resolved
with `select_difficulty` first.

After `POST /actions`, the response includes scene versions, `screenChanged`, `changes` and
`forceReobserve`. A successful function call with no observable scene/game-state change is
reported as `no_effect`.

Unsupported controls are intentionally omitted from affordances. Add an adapter when a
custom `IPointerClickHandler`, drag target or dynamically rendered control cannot be
represented by a standard selectable or existing typed action.

## Runtime notes (first playable loop)

- `ObserverHost` must survive scene loads (`sceneLoaded` re-ensure + `hostTicks` in `/health`).
- `start_new_game` / `continue_game` release the HTTP waiter **before** calling `LoadController`, because scene loads can abort the MonoBehaviour mid-`Update`.
- `GameApplication.InitDone` may stay `false` on `StartScene`; load ops are still enabled.
- Terminal authority is `player.success || controller.game_over`. `over_reason == int.MinValue`
  is an unset sentinel and must not end the run.
- Visible hand for `/scene` uses active `GameController.hand` card widgets.
  `card.bag == 0` remains a broad inventory heuristic in `/state`, not the on-screen hand
  list. `Player.BagIndex` is an allocator cursor.
- Live smoke: `npm run verify:minimal-loop -w @vibesultan/sultan-agent` (no LLM).
