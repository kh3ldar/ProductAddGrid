# ProductAddGrid

A configurable PCF (Power Apps Component Framework) control for adding products to Dataverse records — opportunities, quotes, orders, or any custom entity — from a single multi-tab dialog. It's built as an extended replica of OOB Enhanced Product Add Grid Experience.

Supporting a new parent entity is a JSON entry, not a code change. The control resolves views, columns, lookups, and field types from Dataverse metadata at runtime.

## Demo

**Adding products end to end** — catalog search, inline detail editing, staging, and one committed save.

https://github.com/user-attachments/assets/04d68131-4dfd-4e9b-87ea-0bc7d769897c

**Staging survives a reload** — a half-built basket persists to `localStorage`, so refreshing mid-flow doesn't lose the work.

https://github.com/user-attachments/assets/d56cc23b-da7b-4352-b457-cde9f64e8a36


## What it does

The control opens as a dialog over a parent record and stages products in memory before writing anything to Dataverse. The user builds up a basket, then commits it in one save.

**Catalog tab** — search the product catalog by name or code, filter by configured categories (with nested sub-filters), page through results, and edit quantity and other detail fields inline. Rows auto-stage once their required fields are filled.

**Write-in tab** — enter products that aren't in the catalog. The grid grows a fresh blank row as you fill the last one.

**Product requests tab** — submit price or acquisition requests for products via a Dataverse Custom API, from both catalog search and manual entry.

Staging state is persisted to `localStorage` (debounced, 7-day TTL), so a user who reloads mid-basket doesn't lose their work.

## Design highlights

These are the parts worth reading the source for.

**Entity-agnostic by construction.** There is no per-entity branching in the components. `entities.config.json` declares the parent entity, its detail entity, the views to use, and the field mappings; `ConfigService` resolves the rest. Adding `order` support means adding a config block and creating the Dataverse views.

**Suffix matching for publisher prefixes.** Config refers to fields by unprefixed name. `findValueBySuffix()` in [stringUtils.ts](ProductAddGridComponent/ProductAddGrid/utils/stringUtils.ts) matches `quantity` against `quantity`, `crcad_quantity`, or `emd_quantity` alike, so the same config survives different publisher prefixes.

**Two-layer config with explicit failure.** `system.config.json` holds global defaults and reusable definitions; `entities.config.json` holds per-entity mappings that inherit from them. Setting a field to `null` in entity config explicitly opts out. There are no silent fallbacks — missing config raises, via `getEntityConfigOrThrow()`.

**Metadata-driven columns.** `ColumnService` reads saved-query metadata and Dataverse attribute metadata at runtime to resolve display names, types, and option sets. Column roles are detected in two passes: editable detail-entity fields first, then any match — because product-entity display fields aren't editable but detail-entity fields are.

**Entity variants.** One entity can carry several configs selected by a runtime key, so a single entity with a mode field (e.g. price request vs. acquisition order) gets different views, columns, and rules without a second config entry.

**Declarative business rules.** Auto-set rules (applied at staging) and field conversions (applied at save) are config, not code — including `matchValue: "*"` for any-value matches and `setValue: "$sourceValue"` to copy through.

## Architecture

```
index.ts                          PCF entry point — parses inputs, exposes outputs
└── ProductAddGrid.tsx            StagingProvider wrapper
    └── ProductAddGridContainer   orchestrator: tabs, save, toasts, conditional fields
        ├── CatalogTabManager     ─┐
        ├── WriteInTabManager      ├─ extend BaseTabManager
        └── ProductRequestsManager ─┘
```

`BaseTabManager` centralises the mounted-lifecycle guard so subclasses get safe async `onMount()` / `onUnmount()` hooks for free. `StagingContext` holds staging state once, memoised, and shares it across every tab.

### Services

| Service | Responsibility |
|---|---|
| `ConfigService` | Config access, defaults merge, variant resolution |
| `DataService` | Dataverse operations orchestrator |
| `RecordOperationsService` | Record create/update, field mappings, type conversion |
| `ProductQueryService` | Product search via FetchXML, stock queries |
| `ColumnService` | View metadata retrieval, FetchXML parsing, hybrid views |
| `MetadataService` | Entity/attribute metadata, option sets, display names |
| `CustomApiService` | Custom API (bound action) invocation |
| `StagingPersistenceService` | `localStorage` persistence, 7-day TTL, 1s debounce |
| `CacheService` | TTL-based metadata caching |
| `LocalizationService` | `.resx` string resolution |
| `LoggerService` | Environment-aware logging, suppressed in production |
| `FormattingService` | Number/currency display formatting |
| `FetchXmlUtils` | FetchXML construction helpers |

## Hosting

The control is **not** placed on a form. It is hosted on a **Custom Page**, opened as a dialog by a form or ribbon script. That indirection is what lets one control serve every parent entity.

```
Ribbon / form button
   │  Xrm.Navigation.navigateTo({ pageType: 'custom', ... }, { target: 2 })
   ▼
Custom Page  ──binds──►  PCF inputs   (parentEntityName, parentRecordId)
   ▲                     PCF outputs  (dataOutput, dialogAction)
   │  If(ProductAddGrid.dialogAction = "close", Back())
   └── closes
```

### Manifest contract

| Property | Type | Direction | Purpose |
|---|---|---|---|
| `parentEntityName` | `SingleLine.Text` | input, required | Parent entity logical name (`opportunity`, `quote`, …) |
| `parentRecordId` | `SingleLine.Text` | input, required | Parent GUID, optionally pipe-encoded (below) |
| `displayMode` | `SingleLine.Text` | input, optional | Reserved — currently always resolves to `auto` |
| `dataOutput` | `Multiple` | output | JSON of staged product lines |
| `dialogAction` | `SingleLine.Text` | output | Set to `close` after a successful save |

The control declares `<uses-feature name="WebAPI" required="true" />` and is a `virtual` (React) control using the React 16.14.0 and Fluent 8.120.0 platform libraries.

### Custom Page binding

The Custom Page is a thin shell: it sizes the control to the screen, forwards the two navigation parameters straight through, and listens for the close signal. That's the whole page.

```yaml
Screens:
  Product Details:
    Properties:
      Fill: =RGBA(255, 255, 255, 1)
      LoadingSpinner: =LoadingSpinner.Data
      LoadingSpinnerColor: =RGBA(0, 120, 212, 1)
    Children:
      - ProductAddGridComponent:
          Control: CodeComponent
          ComponentName: emd_eMind.ProductAddGridComponent   # <publisherprefix>_<namespace>.<constructor>
          Properties:
            Height: =Parent.Height
            Width: =Parent.Width
            parentEntityName: =Param("entityName")
            parentRecordId: =Param("recordId")
            OnChange: =If(ProductAddGridComponent.dialogAction = "close", Back())
```

`Param("entityName")` and `Param("recordId")` are populated by the `entityName` and `recordId` keys of the `pageInput` passed to `Xrm.Navigation.navigateTo` — which is how the launcher's pipe-encoded record ID reaches the control unmodified.

### Pipe-encoded record ID

Custom Page parameter passing is limited, so `parentRecordId` carries up to three pipe-delimited parts — parsed in [index.ts](ProductAddGridComponent/ProductAddGrid/index.ts):

```
<guid>                    plain record id
<guid>|<variantKey>       select an entity variant
<guid>||sc=0              override: disable stock checking
```

Empty middle segments are permitted, so `guid||sc=0` sets a flag without selecting a variant.

### Closing and refresh handshake

On a successful save the control both sets `dialogAction = "close"` — which the Custom Page binds to `Back()` — and writes two keys to `localStorage` for the launching script to pick up once the dialog has closed:

| Key | Meaning |
|---|---|
| `productaddgrid_saved_<guid>` | Products were saved; the parent form should refresh |
| `productaddgrid_notifications_<guid>` | JSON array of pre-localised messages to surface |

The control localises every message itself, so the launcher stays a display-only bridge. It can additionally broadcast on a `BroadcastChannel` named `productgrid` to notify other frames on the same origin.

### Launcher

[`examples/launcher.js`](examples/launcher.js) is a working reference implementation of the whole contract — it encodes the record id, saves a dirty parent form before navigating, opens the dialog, and on close consumes the saved-flag and notification keys:

```js
// ribbon button → launchProductAddGrid(primaryControlId, entityTypeName)
Xrm.Navigation.navigateTo(
  { pageType: 'custom', name: CUSTOM_PAGE_NAME, entityName: entityTypeName, recordId: encodedRecordId },
  { target: 2, position: 1, width: { value: 100, unit: '%' } }
).then(() => handleDialogResult(recordId));
```

Point `CUSTOM_PAGE_NAME` at your Custom Page and wire the exported `launchProductAddGrid` to a ribbon button.

## Building

```bash
cd ProductAddGridComponent
npm install
npm run build      # dev build, debug logging enabled
npm run lint
```

`npm run build` produces the control bundle. Packaging it into a solution and importing it is environment-specific and deliberately not included here.

### On running it locally

**This control cannot run in the PCF test harness.** It declares `WebAPI` as a required feature and reaches Dataverse through `context.webAPI` for every query — product search, view metadata, attribute metadata, option sets, Custom API calls. There is no fetch fallback and no mock layer. It also depends on a Custom Page host to supply its inputs and to act on `dialogAction`.

Exercising it means deploying to a Dataverse environment with the product schema, saved queries, and Custom Page it expects. The build and lint steps above are what's verifiable standalone.

## Stack

TypeScript 5.8 (strict) · React 16.14 · Fluent UI 8 · Power Apps Component Framework · `pcf-scripts` / webpack 5 · English + Turkish `.resx` localisation (1033 / 1055)

Class components handle orchestration; grids and presentational pieces are memoised function components.
