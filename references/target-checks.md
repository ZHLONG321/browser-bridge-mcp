# Verify the target and login before interpreting errors

Use the user's URL, already-open page, browser/profile/window or account context as the selection reference. Before treating a 401/403, sign-in page, missing data or another unexpected error as an access/service limitation:

- Match the live connection, browser family, profile, normal/private window and exact tab. Check its current URL, redirects, title and relevant visible content. The first tab on the same domain may be a different target.
- Check that specific page's login, sign-in redirects and visible account. When identity changes the result, compare the account display with a successful authenticated read in the same page session. Do not print credentials, cookies or tokens.
- For a page API request, verify the endpoint and authentication method against the page implementation or observed requests. Compare the failure with an ordinary successful authenticated request in the same session. A guessed endpoint's error or another profile's response cannot establish that the requested data is unavailable.

Correct a demonstrated mismatch within the existing authorization. If the correctly matched, logged-in session still fails, report its actual response and evidence ruling out a target/login mismatch. Distinguish unavailable access from nonexistent data. Do not bypass access controls, switch accounts, change permissions, or focus/navigate unrelated pages to overcome an error. Ask for missing target information only when the available state cannot resolve the distinction.
