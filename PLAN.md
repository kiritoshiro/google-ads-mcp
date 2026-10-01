# Release plan

1. Preserve the existing read-only Google Ads tools and the two narrow write tools. Add date windows and keyword reporting so the first account review can cover historical activity.
2. Bound queries and responses, validate identifiers and dates, sanitize errors, time out upstream requests, and restrict local HTTP access by host and origin.
3. Keep OAuth credentials in a local ignored `.env`, improve the login helper, and document Google Cloud API access and private MCP connection options.
4. Verify request handling, tool metadata, query limits, and write gates with local tests. Test against a real Ad Grants account only after the owner supplies OAuth credentials outside Git.
5. Publish the reviewed source and lockfile to the supplied GitHub repository. Later releases can add campaign creation, ads, PMax, change history, and website policy checks after live account data validates the design.
