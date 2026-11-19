# potion-code-16M-v2

The static embedding model `trail ask` uses for semantic ranking, by MinishLab, copied unchanged from https://huggingface.co/minishlab/potion-code-16M-v2 at revision `e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b` on 19 November 2026. Its model card (`README.md` here) gives the licence as MIT and names no copyright line; `LICENSE` here is the MIT text, with the holder named as the publisher and the authors the card cites.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `model.safetensors` | 32,490,072 | `75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c` |
| `tokenizer.json` | 1,024,340 | `107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45` |
| `config.json` | 59 | `148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7` |

`test/ask-embed.test.ts` checks the model's hash and that `src/ask/embed.ts` reproduces model2vec's token ids and vectors.
