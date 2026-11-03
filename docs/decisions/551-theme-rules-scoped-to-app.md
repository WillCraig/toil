# Theme rules that draw decoration are scoped to the app's own elements (#551)

- Harvest's sky strip (`header::before`) now targets `.app-header`, a class the app
  header in `ui/src/App.tsx` carries. The bare rule also drew it on the game's
  `<header className="pm-story__topline">` and would on any header a new screen adds.
- Sprawl's title cursor, glitch and neon split on `h1` now target `#main h1`: the page
  titles all live in `main#main`, and the game and its story intro sit outside it.
- Left as they are: theme rules on bare elements that only set typography or base
  look (`h1`, `h2`, `button`, `input`, `img`, `body` and its pseudo-elements). Every
  screen is meant to inherit those, and rewriting them onto classes would touch
  every theme for no visible change. Only rules that add boxes or animation to every
  instance of an element leak the way the strip did, and these two were the only ones.
