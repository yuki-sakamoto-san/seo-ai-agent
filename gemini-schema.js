{
  "name": "fetch_url",
  "description": "Fetches a URL and returns cleaned, visible page text for analysis.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "HTTP(S) URL to fetch and convert to readable text." },
      "selector": { "type": "string", "description": "Optional CSS selector to target main content if known." }
    },
    "required": ["url"]
  }
}
