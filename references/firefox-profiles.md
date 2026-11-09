# Match a Firefox account, profile and connection

Use this only when the user identifies a Firefox by an account or profile screenshot. A Mozilla email, website account, physical Firefox profile, extension `profile_id` and live extension/RDP `connection_id` are separate identities. The bridge neither reads website credentials nor automatically associates an RDP session with an extension.

Start with `discover()` without a port. Enumeration opens no RDP prompt. Resolve the user's supplied information against live candidates and carry explicit identifiers on each call. If the remaining distinction is available from the authorized target's visible account display, inspect that page in the background. Do not inspect unrelated accounts or infer a website login from the Mozilla email.

## Physical profile and Mozilla account

When identification requires it and an accepted RDP connection has browser-chrome debugging enabled, obtain its actual profile and requested account identifier through native packets:

| Native request | Retain from its response |
| --- | --- |
| `{"to":"root","type":"getRoot"}` | `deviceActor` |
| `{"to":deviceActor,"type":"getDescription"}` | `value.profile` (name/leaf only, not full directory proof) |
| `{"to":"root","type":"getProcess","id":0}` | `processDescriptor.actor` |
| `{"to":processDescriptor,"type":"getTarget"}` | `process.consoleActor` |

Use `rdp(connection_id=..., packets=[packet], after=cursor, wait_ms=100)` and advance from `next_cursor`. Send sequential requests on a coordinated connection and collect the expected actor response; arbitrary stream entries are not completion evidence. On the privileged **parent-process console**, use `type: "evaluateJSAsync"`, `text` below, `disableBreaks: true`, `mapped: {await: true}`:

```javascript
(async () => {
  try {
    const {getFxAccountsSingleton} = ChromeUtils.importESModule(
      'resource://gre/modules/FxAccounts.sys.mjs');
    const account = await getFxAccountsSingleton()._internal.getUserAccountData(['email']);
    return JSON.stringify({
      profile_path: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
      email: account?.email ?? null
    });
  } catch (error) {return JSON.stringify({acquisition_error: String(error)});}
})()
```

The first reply gives `resultID`. Poll until an `evaluationResult` event matches that ID **and** console actor; check `hasException`, `topLevelAwaitRejected` and `acquisition_error`, then parse the resolved string. Request only `email`; never dump account records, `signedInUser.json`, credentials or tokens. Report an identity match without copying the address when unnecessary. Internal account interfaces are version-sensitive: if the current module/export differs, inspect that installed source before substituting an accessor. Do not instantiate another account service or casually replace it with `getSignedInUser()`, which may refresh remote account state.

No email means this lookup returned no Mozilla email; it says nothing about website logins. Without privileged RDP access, use independently available profile evidence or ask for the remaining user-visible distinction. Do not claim the inaccessible internals can be determined from tab titles/URLs alone.

## Associate extension and RDP

Use a fresh owned marker; ordinary URLs, titles, counts and tab order can coincide:

1. Through the candidate extension's `webextension`, create an authorized background tab with `tabs.create`, `args: [{url: 'about:blank#browser-bridge-profile-<fresh-uuid>', active: false, windowId: selectedWindowId}]`, `mode: authorized_mutation`. The window ID comes from the selected normal/private inventory.
2. Poll `tabs.get` on its returned native ID until the exact marker URL has committed and the tab is inactive.
3. On the candidate **already accepted** RDP sessions, send `root.listTabs` and collect the root response containing `tabs`. One session showing the exact fresh marker establishes this association. Multiple matches may be several RDP sessions to the same profile; coordinate ownership rather than choosing the first. Zero matches proves no association.
4. Retain the mapping only for this task. Revalidate when the target/connection is replaced. The bridge does not persist or enforce the mapping. Close only the exact owned inactive tab after rechecking its marker, within the user's authorization; handle failure the same way. Deletion approval rules still apply.

If no accepted RDP exists, extension/page work can proceed without it. For RDP, find the intended process's known loopback listener; obtain permission for its possible incoming-connection prompt, then connect explicitly and let the user accept. Do not disable confirmation, silently launch another profile, or ask the user to supply internal UUIDs. A supplied account/name can legitimately match several profiles; ask for a meaningful remaining distinction when available evidence cannot select one.

Sources: Mozilla [root spec](https://searchfox.org/firefox-main/source/devtools/shared/specs/root.js), [process descriptor](https://searchfox.org/firefox-main/source/devtools/shared/specs/descriptors/process.js), [console spec](https://searchfox.org/firefox-main/source/devtools/shared/specs/webconsole.js), [account implementation](https://searchfox.org/firefox-main/source/services/fxaccounts/FxAccounts.sys.mjs), [account field selection](https://searchfox.org/firefox-main/source/services/fxaccounts/FxAccountsStorage.sys.mjs).
