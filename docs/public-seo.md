# Public discovery and signup

The public routes are deliberately separate from account data:

- `/`: server-rendered product introduction and signup/sign-in navigation.
- `/guides/job-application-checklist`: original practical guide, readable without JavaScript.
- `/sitemap.xml`: an explicit allowlist of those two canonical pages. No profiles, resumes, applications, dashboard routes or query parameters.
- `/robots.txt`: advertises the sitemap. Private routes remain crawlable so crawlers can see their `X-Robots-Tag: noindex, nofollow` response headers. Authentication, not crawler rules, protects data.
- `/assets/marketing.css`: local responsive CSS, with no external fonts or JavaScript dependencies.

The public handler takes precedence over the previous `/` dashboard shell. Existing application links continue at `/assistant`; `/signup` and `/login` are account-shell routes with noindex headers. Marketing pages never read the database or include a signed-in user's data, so their five-minute public cache is independent of authentication.

## Configuration

`PUBLIC_SITE_ORIGIN` is the public canonical HTTPS origin. It defaults to the existing primary deployment, `https://marvelous-vitality-production-c2d8.up.railway.app`. Set it deliberately when moving to a verified custom domain; no redirects or DNS changes are made by this implementation. It is not derived from incoming Host headers. Only a bare HTTPS origin is accepted.

For nonpublic/staging deployments, set `SEO_INDEXABLE=false`. That returns noindex metadata on public HTML, a disallow-all robots file, and an empty sitemap. To remove a previously indexed URL, let crawlers retrieve its noindex response rather than first blocking it in robots.txt.

Production needs working public signup before promoting the create-account calls to action. The `PUBLIC_SIGNUP` setting and registration protections are maintained by the account implementation. Do not claim public signup is launched until it is enabled and tested on the published host.

## Verification

Run `node --test checks/public-seo.test.js checks/accounts-security.test.js` for content, metadata, canonical configuration, sitemap, private-route boundaries and account isolation checks. Public tests cover GET/HEAD, staging opt-out, CSS serving and no-JavaScript navigation. Run `npm test` for the full repository suite.

Browser visual validation was attempted with the available system Chromium, but this executor disallowed its process-singleton socket. Desktop/mobile screenshots, real rendering accessibility and Core Web Vitals remain unverified; DOM checks are not a substitute for those measurements.

After an authorized deployment:

1. Check public HTML, stylesheet, robots and sitemap on the canonical host; test signup and sign-in as a fresh user.
2. Confirm account/API/resume responses still require authentication or contain only the shell, and have noindex headers.
3. In the owner's Google Search Console property, inspect the two public URLs and submit `/sitemap.xml` after the owner authorizes or performs verification. Never put verification tokens in source without the appropriate authorization.
4. Measure real search impressions, useful query traffic and signup conversion. No ranking, indexing, traffic or signup outcome is guaranteed.
5. Improve useful product content based on observed user needs. Do not generate doorway pages, fabricated job listings, reviews, ratings or success claims. The only structured data is factual WebSite identity; no JobPosting or rating markup is used.

References consulted: [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide) and [Google noindex guidance](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
