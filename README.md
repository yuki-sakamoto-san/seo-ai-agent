## SEO AI Agent 

In this repository, you’ll find a JavaScript file that can be loaded into your Gemini knowledge base.
Keep in mind that it will only work if your Gemini (Enterprise) instance has the capability to execute JavaScript code rather than just read it.

Before using it in production, make sure to:

Test execution in a controlled environment (e.g., run a sample query with limited scope).

Verify outputs such as the generated CSV (serp_headings.csv) and JSON (serp_summary.json) files.

Check permissions (Gemini must be allowed to launch headless browsers and make external requests to Google SERPs).

Validate localization by testing queries in different countries, languages, and cities to confirm that UULE/country parameters work as expected.

Review API limits if you switch to or combine with SerpAPI for stability.

Once confirmed, you can safely integrate the file into your Gemini Gem to enrich your agent with SERP scraping and content-structure insights.
