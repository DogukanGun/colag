# AMD entries

Colag's product entry for the October AMD hackathon is the support desk in the room. A customer message is answered only from the company documents. The draft cites the file the answer came from, or it cites nothing and leaves the answer empty. A member approves the reply or sends it back. The draft cannot send itself.

The same rule is the grader-facing half for Academy mini-challenge 3, in `mc3/`.

## Academy signup

This part is an account, not a repository change.

1. Sign up with AMD from https://lablab.ai/ai-hackathons/amd-lablab-ai-academy-challenge and join the AMD AI Developer Program if the form asks for it.
2. Join the lablab Discord and the AMD Discord from the buttons on that page.
3. Connect the AMD account, claim the cloud credits, and finish one AMD AI Academy tutorial. That is mini-challenge 1. No project is submitted for it.

One AMD Developer Program account also covers the 12–18 October hackathon at https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-iii.

## Challenge 3 container

The evaluation image is the ROCm PyTorch base. GPU time for building it is the notebook at https://notebooks.amd.com/hackathon (3 hours a day). Turn the session off when you stop.

```bash
docker build -t colag-mc3 hackathon/amd-academy/mc3
docker run --rm -d --name colag-mc3 --device=/dev/kfd --device=/dev/dri colag-mc3
docker exec colag-mc3 python3 /app/app.py --index /app/corpus
docker exec colag-mc3 python3 /app/app.py --corpus /app/corpus --query-id query_01 --query "..."
```

`--index` runs once. Each question is a new `python3 /app/app.py` process. The daemon keeps the index. A question writes `/app/output/<query-id>_output.json` with `answer`, `citations`, and `confidence`. An answer that is not in the folder is an empty string and an empty citation list.

Local check, without a GPU:

```bash
python3 hackathon/amd-academy/mc3/selfcheck.py
```

## What is not in this folder

Mini-challenge 2 (plates and road signs) is a vision benchmark and is not the entry. Challenges 4, 5, and 6 have no published contract. Challenge 5 is the one that can use the room, and only after its contract is published.

The Legend cash prizes require a final challenge that is still locked. It opens in the closing weeks, before 1 December 2026. Finish it on this same AMD account once it unlocks. The points that have to already be there are the Academy tutorial, this container, and the October support-desk submission.
