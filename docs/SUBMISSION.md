**Answered** puts a Telegram audience on the host's Even Realities G2 display. Questions are merged and ranked on the glasses, the host answers them out loud, and the bot replies in the group to everyone who asked.

🎬 **Demo video (2:51):** https://github.com/linoxbt/Answered/raw/main/docs/demo/answered-demo.mp4
💻 **Code:** https://github.com/linoxbt/Answered
🤖 **Bot:** [@answereddbot](https://t.me/answereddbot)

![Answered: the Telegram group on the left, the G2 display on the right](https://raw.githubusercontent.com/linoxbt/Answered/main/docs/img/demo-thumb.png)

## The problem

Crypto and creator communities run their AMAs and community calls in Telegram. During a live call the chat explodes: the same question is asked a dozen different ways, buried under "gm", repeats and scam links. The host is talking, so they can't read the chat. They scroll, miss most of the questions, answer whichever one they happen to see, and the people who asked never learn that their question was answered.

## How it works

1. **Pair:** the glasses show a 4-digit code and a group admin sends `/pair <code>` to the bot. No accounts, no phone app.
2. **Go live:** one press on the ring. The bot posts an opening message in the group.
3. **Collect:** every message is read by Claude Haiku 5.5, which drops chatter and spam and merges repeats. The queue on the glasses shows one line per question, ranked by how many people asked.
4. **Answer:** the host takes the top question and simply answers it out loud. The G2 microphone streams to Deepgram Nova-3.
5. **Verify:** Claude Sonnet 5.5 decides whether the question was really answered, and must back it with a quote from the transcript. Talking around a question doesn't count.
6. **Reply:** after a 2-second undo window, the bot posts one threaded reply to the original message, with a short summary, tagging everyone who asked.
7. **Recap:** a double press ends the session. The recap of what was answered and what is still open is posted and pinned in the group.

## Key features

- **Duplicate merging:** "wen mainnet?", "mainnet when?" and "any update on the mainnet date?" become one question, "asked 5 times by 2 people".
- **Hands-free answering:** no typing. The host talks, Answered writes the reply.
- **No false "answered":** non-answers stay open, and nothing is posted without a supporting quote.
- **Everyone gets notified:** each asker is @mentioned in a threaded reply, and 👀 / 👍 reactions show progress.
- **Full ring control:** press = take / answered, swipe = scroll / skip, double press = put back / end, long press = flag spam (deletes it from the group).
- **Pinned recap:** answered questions with timestamps, plus the list of questions still open.
- **Privacy:** audio is never stored; raw messages and transcripts are deleted when a session ends.

## Tech stack

- **Glasses:** Even Hub SDK 0.0.16, TypeScript + Vite, native list container, G2 microphone via `audioControl`, packaged as `.ehpk`.
- **Server:** Node.js, Fastify 5, WebSockets, SQLite, deployed on Railway.
- **Telegram:** grammY bot (webhook), threaded replies, mentions, reactions, pinned messages, rate-limited outbox.
- **AI:** Claude Haiku 5.5 (detection, spam, clustering), Claude Sonnet 5.5 (answer judge), Deepgram Nova-3 streaming speech-to-text.

**Measured results** (scorecard in the repo, 3 runs): 100% of questions detected, 0 false merges, 30 of 30 answers judged correctly, a median of 6.1 s from the end of speech to the posted reply.

## Hackathon requirements

- **Track:** Track 01 · Messaging & News. Also eligible for Best Telegram integration and the Grand Prize.
- **GitHub repo:** https://github.com/linoxbt/Answered (setup, architecture and a "What existed before 23 Nov" section).
- **Demo video:** link above, one continuous take on the live server with two real Telegram accounts.
- **Installable app:** `release/answered.ehpk` in the repo.
- **Feature requests for Even Realities:** in the README (list updates without page rebuilds, list selection events, text emphasis, on-device end-of-speech detection, a headless simulator).
- **Testing:** tested end to end in the Even Hub simulator against the live server and real Telegram groups. We had no physical G2.
