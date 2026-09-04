# The Seal of Slop

Slopcoding is okay sometimes. Maybe you just have a funny idea you wanted to try out? Perhaps you need a prototype of something just to see if the concept works? Or maybe it's the only way you can scale yourself enough to build something?

But it's also frustrating to be presented with something that implicitly claims to be 100% human work but also has all the tell-tale signs. The purple gradients. The weird little smallcaps subtitles. The Dramatic. Staccato. Prose.

So I made a way to openly communicate that something is vibecoded. A little wax seal (or sticker if you prefer) to put on your page. You write a personal statement, explaining how you made the thing and how much it should be trusted.

That's all. Who knows if this is a good idea.

See it on the [project page](https://rossng.github.io/seal-of-slop/), which
wears one.

## Install

```sh
npm install seal-of-slop
```

## Use

```html
<script type="module">
  import 'seal-of-slop'
</script>

<seal-of-slop
  size="128"
  design="seal"
  text="An agent wrote this page. I read all of the code before I published it,
but I did not write it.

There are no tests and no support. Use it as a toy."
></seal-of-slop>
```

When you import the package, it registers the `<seal-of-slop>` element. The
element has three attributes, and no other configuration.

| Attribute | Default | Description |
| --- | --- | --- |
| `size` | `128` | The width and the height of the seal, in CSS pixels. |
| `design` | `seal` | Use `seal` for pressed wax. Use `sticker` for printed vinyl. |
| `text` | none | Your personal statement about the slopcoded project. |

If you do not set `text`, the seal is decorative only.

Use CSS to position the seal. The element is an `inline-block` element of the
size that you set. To affix the seal in a corner of the window, set
`position: fixed` and two offsets.

## What to write in the text

The seal tells the reader that an AI agent wrote the page. So you should write the personal statement yourself! Consider:

1. **How much of the code did you read?** Did you read none of it? Did you
   discuss the design with the agent first? Did you review every line? Say which.
2. **Why did you make it?** Or, if an AI wrote it, why is it still interesting?
3. **How correct is the code, and what support will you give?** Say if it is
   ready for production, if you will fix bugs, or if it is only a toy.

## Development

The texture renders in `art/` are stored in [Git LFS](https://git-lfs.com), so
install it before you clone.

```sh
git lfs install

pnpm install
pnpm dev        # start the demo page
pnpm build      # build the package
pnpm site       # build the GitHub Pages site into dist-site/
pnpm assets     # rebuild src/assets.ts from the renders in art/
```

### Releasing

Releases are handled by [changesets](https://github.com/changesets/changesets).
When you make a change worth publishing, add a note about it:

```sh
pnpm changeset   # pick major/minor/patch, write one line about the change
```

Commit the generated file in `.changeset/` with your change. When it lands on
`main`, the Release workflow opens a pull request that bumps the version and
writes the changelog. Merge that pull request and the same workflow publishes
the package to npm, using OIDC trusted publishing, so there is no npm token in
the repository.

## Licence

[Blue Oak Model License 1.0.0](LICENSE).
