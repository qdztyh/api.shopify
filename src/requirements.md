The following files have these dependencies (+ TypeScript):
```
npm i @sanity/client uuid groq 
```

Invoke `handle(body)` in `handleRequest.ts`, where body is the request body of your endpoint.

For Next.js that might look like

```js
import {handle} from './handleRequest'

export default async function handler(req, res) {
  // Next.js will automatically parse `req.body` with requests of `content-type: application/json`,
  // so manually parsing with `JSON.parse` is unnecessary.
  const { body, method } = req;

  // Ignore non-POST requests
  if (method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  await handle(body)

  res.status(200).json({ message: "OK" });
}
```