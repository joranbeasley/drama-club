# Drama Club for agents

Drama Club plans productions as boards: **characters**, **locations**, **props** (objects and outfits), **episodes** made of **scenes**, and scenes made of **shots**. This API lets an agent set them up for a user.

- API description (OpenAPI 3.1): [`/api/openapi.json`](api/openapi.json)
- Auth: a personal API token the user makes in the app (account menu → **API tokens…**), sent as `Authorization: Bearer dc_…`. It acts as that user, on their productions.
- Everything is JSON. Send `Content-Type: application/json` with bodies.

## Read first

```http
GET /api/productions                         → { productions: [{ id, title, version, … }] }
GET /api/productions/{id}/outline            → { production, outline }
```

The outline lists every character, location, prop, episode, scene and shot with its `id`, and for each shot who is on screen, where, and what each character is **wearing** (after episode → scene → shot overrides).

## Set up a scene in one call

```http
POST /api/productions/{id}/scenes
{
  "episode": "Opening Night",
  "time": "NIGHT",
  "description": "The lights fail mid-performance.",
  "location": "School hall",
  "wardrobe": { "Maya": "Stage blacks" },
  "shots": [
    { "framing": "Wide", "characters": ["Theo", "Jules"], "description": "The stage goes dark mid-line.", "duration": 4 },
    { "framing": "Close-up", "characters": ["Maya"], "props": ["Torch"], "description": "Maya grabs a torch in the wings." },
    { "framing": "Medium", "characters": ["Maya", "Theo"], "description": "She lights his face; he finishes the line.", "continues": true }
  ]
}
```

- Characters, locations, props, outfits and episodes are given **by id or by name** (names match ignoring case). Ones named but not found are **created**; the response's `created` lists them. Send `"createMissing": false` to refuse instead.
- Shots are added in order and numbered; the scene is numbered next in its episode.
- `location` on the scene is the default for its shots; a shot can name its own.
- `wardrobe` maps characters to outfits: on the scene it dresses them in all its shots; on a shot, only there. `"usual"` means their own clothes.
- `continues: true`: this shot is the same camera take carried on from the shot before it (its clip starts on that clip's last frame).

Values: `framing` is one of Wide, Full, Medium, Close-up, Extreme close-up, Two-shot, Over the shoulder, Point of view, Insert. `movement`: Static, Pan, Tilt, Dolly, Tracking, Handheld, Crane, Zoom. `time`: DAY, NIGHT, MORNING, EVENING, CONTINUOUS, LATER. `setting`: INT, EXT. `duration`: seconds (clips are 4 to 15 s).

## Smaller steps

```http
POST   /api/productions/{id}/characters   { name, description?, appearance?, actor? }
POST   /api/productions/{id}/locations    { name, setting?, description? }
POST   /api/productions/{id}/props        { name, kind?: "Object" | "Outfit", description?, usuallyWornBy? }
POST   /api/productions/{id}/episodes     { title, number?, description?, style? }
POST   /api/productions/{id}/shots        { scene, framing?, characters?, location?, props?, description?, … }
PUT    /api/productions/{id}/wardrobe     { at: <episode|scene|shot id>, character, outfit: <outfit> | "usual" | "inherit" }
PATCH  /api/productions/{id}/items/{itemId}   { …fields to change }
DELETE /api/productions/{id}/items/{itemId}
```

Write good **appearance** text for characters (age, build, hair, face, usual clothes): it goes word for word into every video prompt they are in, which keeps them consistent. A shot's **description** is what we see and hear.

## Versions

Every change returns the production's new `version`. Add `?version=N` to a write to apply it only if nobody changed the production since you read it (409 otherwise). Without it, the change goes onto the latest version. A user with the production open in the app is offered the new version.

## Not here

Pictures and video clips are made in the app (✨ and 🎬), with the user's own AI keys. Deleting a production isn't available to tokens.
