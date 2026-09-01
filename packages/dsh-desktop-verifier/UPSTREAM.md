# Upstream attribution

The fine-grained A-T logprob reward, pairwise evaluation prompt, Bradley-Terry aggregation, and Probabilistic Pivot Tournament in this package are a native TypeScript adaptation of:

- Repository: https://github.com/llm-as-a-verifier/llm-as-a-verifier
- Commit: `8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770`
- License: MIT

DSH Desktop intentionally does not embed the Python runtime. It fixes the interactive product policy at best-of-three, one pivot, one evaluation per directed pair, and integrates the algorithm through DSH's native model, session, settings, credentials, and UI extension seams.
