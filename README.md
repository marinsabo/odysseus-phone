# Phone page

Calories, protein and a weigh-in, typed while the laptop is somewhere else. See decision 84.

    phone (this page) ──► private GitHub repository ──► laptop (etl/phone.py)
                      ◄── snapshot.json             ◄──

Nothing here is built: the folder is what gets published. Tests: `node --test phone/logic.test.mjs`.

## Setting it up

1. Create the **private** data repository, e.g. `odysseus-phone-data`.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to
   that one repository and one permission: **Contents, read and write**.
3. On the laptop, run `.venv/bin/python -m odysseus setup` from `daemon/`. The phone page prompts are
   last. Give the repository as `owner/name`, and the token.
4. Publish this folder to GitHub Pages. Pages on a free account needs a public repository, which is
   fine: the page holds no data and no secret. Keep it apart from the private data repository.
5. On the phone, open the page, enter the repository and the token, then add it to the home screen. On an
   iPhone do this from Safari: the home-screen version keeps its storage, a Safari tab may lose it.

If the token is ever lost or exposed, revoke it on GitHub. It opens that one repository and nothing else.
