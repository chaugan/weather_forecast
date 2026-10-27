# Dog-walk widget: picture prompts

Prompts for the pictures in the dog-walk widget ("Hundetur"). Paste each prompt into an image model; each one stands
on its own. Owner, 2026-10-27.

## What is needed

| | Count | Size | Used in |
|---|---|---|---|
| Colour pictures | 2 walkers × 5 weathers = 10 | Square, at least 1024 × 1024 px (2048 × 2048 is better) | The 2x2 Home Screen widget, edge to edge |
| Silhouettes | 2 walkers × 5 weathers = 10 | Square, at least 1024 × 1024 px, black on white | The Lock Screen widget, in the Lock Screen's tint |

The five weathers are sunny, overcast, windy, rain and snow. The widget picks one from the weather right now:
1. **Rain or snow** if precipitation is falling, by MET's radar where there is one, otherwise by the models.
2. **Windy** if the mean wind is 30 km/h (8 m/s) or more.
3. **Sunny** for clear or partly cloudy.
4. **Overcast** for cloudy or fog.

There are no night pictures yet. At night the same five are used.

## How to get a consistent set

1. Make **woman, sunny** first, and generate it again until the woman, the corgi and the style are right.
2. Give that picture to the model as a reference for every other picture ("same characters, same style, same camera,
   same scale and horizon"), and only change the weather.
3. Do the man the same way: first **man, sunny** with the woman's sunny picture as the style reference, then the rest.
4. Make the silhouettes last, with the colour picture of the same walker and weather as a reference for the pose.

## The layout the pictures must leave room for

On the 2x2 widget, the place name and the temperature are drawn in white at the **top left**. A small card with the
rain forecast covers the **bottom 30 %**, unless the user turns it off. The walker and the dog must stay clear of
both areas, so the prompts place them on the right, in the middle band.

## File names

Send the files with these names, and I'll put them in the app. White silhouette backgrounds are turned into
transparency here, so they don't need to be transparent.

- Colour: `dogwalk-woman-sunny.png`, `dogwalk-woman-overcast.png`, `dogwalk-woman-windy.png`, `dogwalk-woman-rain.png`,
  `dogwalk-woman-snow.png`, and the same with `man`.
- Silhouettes: the same names ending in `-lock`, such as `dogwalk-woman-sunny-lock.png`.

## Colour pictures

### `dogwalk-woman-sunny.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Sunny, clear day: deep blue sky, a bright sun in the top-right corner, crisp short shadows on the path, fresh green grass. The walker wears a light open jacket, a T-shirt, jeans and white sneakers, and sunglasses pushed up on the head. The corgi trots happily with its tongue out.
```

### `dogwalk-woman-overcast.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Overcast day: a flat, even blanket of grey clouds, soft diffuse light with no shadows, muted greens and greys. The walker wears a casual mid-weight jacket, jeans and sneakers. The corgi walks calmly, nose down.
```

### `dogwalk-woman-windy.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Windy day: fast-moving broken clouds in a blue-grey sky, a few leaves flying across the scene, trees in the background bending to the right. The walker's hair and a long scarf blow to the right, jacket flapping; The walker leans slightly into the wind. The corgi's ears and fur are blown back, the leash curves in the wind.
```

### `dogwalk-woman-rain.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Rainy day: dark grey sky, steady diagonal rain streaks, puddles on the path with small splashes and reflections. The walker wears a yellow rain jacket with the hood up and rubber boots, and holds a clear umbrella in the free hand. The corgi wears a small yellow raincoat and steps around a puddle.
```

### `dogwalk-woman-snow.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Snowy winter day: pale grey-blue sky with large soft snowflakes falling, snow-covered ground and bushes, footprints in the snow behind them. The walker wears a warm puffer jacket, a knitted beanie, a scarf, mittens and winter boots, breath visible as a small cloud. The corgi has snow on its back and leaves little paw prints.
```

### `dogwalk-man-sunny.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Sunny, clear day: deep blue sky, a bright sun in the top-right corner, crisp short shadows on the path, fresh green grass. The walker wears a light open jacket, a T-shirt, jeans and white sneakers, and sunglasses pushed up on the head. The corgi trots happily with its tongue out.
```

### `dogwalk-man-overcast.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Overcast day: a flat, even blanket of grey clouds, soft diffuse light with no shadows, muted greens and greys. The walker wears a casual mid-weight jacket, jeans and sneakers. The corgi walks calmly, nose down.
```

### `dogwalk-man-windy.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Windy day: fast-moving broken clouds in a blue-grey sky, a few leaves flying across the scene, trees in the background bending to the right. The walker's hair and a long scarf blow to the right, jacket flapping; The walker leans slightly into the wind. The corgi's ears and fur are blown back, the leash curves in the wind.
```

### `dogwalk-man-rain.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Rainy day: dark grey sky, steady diagonal rain streaks, puddles on the path with small splashes and reflections. The walker wears a yellow rain jacket with the hood up and rubber boots, and holds a clear umbrella in the free hand. The corgi wears a small yellow raincoat and steps around a puddle.
```

### `dogwalk-man-snow.png`

```text
Modern flat vector illustration with soft gradients and a very subtle paper grain; rounded, friendly shapes; calm Scandinavian editorial look; limited, harmonious palette; no outlines; no text, letters, logos, borders, frames or watermarks. Square 1:1 image. Side view, the walker and the dog walking from left to right along a park path, both fully visible from head to feet. Place them in the right-hand two thirds of the image, between about 30 % and 70 % of the image height (their feet at about 70 %), the dog just in front of the walker on a slack leash. Keep the top-left area (left half, top third) as plain sky with no objects, and keep the bottom 30 % as simple ground or path with no important details: text and a small card are placed over those areas. Put the main weather element (sun, clouds, snowfall) in the top-right sky. Horizon at about 70 % of the image height. The walker: a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build. The dog: a Pembroke Welsh Corgi with a red-and-white coat, white chest and legs, big upright ears, a fluffy natural tail, a royal-blue collar and a royal-blue leash. Snowy winter day: pale grey-blue sky with large soft snowflakes falling, snow-covered ground and bushes, footprints in the snow behind them. The walker wears a warm puffer jacket, a knitted beanie, a scarf, mittens and winter boots, breath visible as a small cloud. The corgi has snow on its back and leaves little paw prints.
```

## Silhouettes (Lock Screen)

### `dogwalk-woman-sunny-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: a sun with short bold rays in the top-right corner.
```

### `dogwalk-woman-overcast-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: one large simple cloud shape in the top-right corner.
```

### `dogwalk-woman-windy-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker's scarf and hair blowing to the right and three bold curved wind lines in the top-left.
```

### `dogwalk-woman-rain-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker holding an open umbrella and four or five bold rain drops falling around it.
```

### `dogwalk-woman-snow-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young woman in her mid-twenties with shoulder-length light-brown hair in a loose low ponytail, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker in a beanie with a pom-pom and four or five bold six-armed snowflakes around them.
```

### `dogwalk-man-sunny-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: a sun with short bold rays in the top-right corner.
```

### `dogwalk-man-overcast-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: one large simple cloud shape in the top-right corner.
```

### `dogwalk-man-windy-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker's scarf and hair blowing to the right and three bold curved wind lines in the top-left.
```

### `dogwalk-man-rain-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker holding an open umbrella and four or five bold rain drops falling around it.
```

### `dogwalk-man-snow-lock.png`

```text
Square 1:1 image. A single solid pure-black silhouette on a pure-white background: flat, no gradients, no shading, no grey, no outlines, no text. Side view of a young man in his mid-twenties with short dark-blond hair, light stubble, a friendly relaxed face and a slim build walking from left to right with a Pembroke Welsh Corgi (big upright ears, fluffy tail) on a leash, both fully visible from head to feet, together filling most of the square (the walker on the left, about 85 % of the image height; the dog in front on the right, about 35 % of the height). Bold, simple shapes that still read when the image is shown at 70 × 70 pixels; leave a small white gap between the walker, the dog and the leash. Weather element, also solid black: the walker in a beanie with a pom-pom and four or five bold six-armed snowflakes around them.
```
