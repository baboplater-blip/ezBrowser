#!/usr/bin/env python
# board-card.py — .auto-dev/board.json 에 카드를 추가/갱신한다.
#
# 왜 이 파일이 있는가 (2026-09-19): 팀장 정책은 `<스킬>/runtime/orchestrator.py board update` 를
# 쓰라고 하지만, 이 PC 의 auto-dev 스킬 설치본에는 runtime/ 디렉터리가 없다(SKILL.md·packet_check.py·
# token_log.py·token_summary.py 뿐). 우회하지 않고 같은 스키마로 같은 일만 하는 최소 도구를 둔다.
# orchestrator 가 설치되면 이 파일은 지워도 된다.
#
# 사용: python .auto-dev/board-card.py --id <카드id> --column <열> --step "..." [--evidence "..."]
#       [--blocker "..."] [--owner "..."] [--model "..."] [--title "..."]

import argparse
import json
import pathlib
import datetime

BOARD = pathlib.Path(__file__).with_name('board.json')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True)
    ap.add_argument('--column', required=True)
    ap.add_argument('--step', default=None)
    ap.add_argument('--evidence', default=None)
    ap.add_argument('--blocker', default=None)
    ap.add_argument('--owner', default=None)
    ap.add_argument('--model', default=None)
    ap.add_argument('--title', default=None)
    a = ap.parse_args()

    board = json.loads(BOARD.read_text(encoding='utf-8'))
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    cards = board.setdefault('cards', [])

    card = next((c for c in cards if c.get('id') == a.id), None)
    if card is None:
        card = {
            'id': a.id, 'title': a.title or a.id, 'column': a.column, 'owner': a.owner,
            'model': a.model, 'step': a.step, 'evidence': a.evidence, 'blocker': a.blocker,
            'detail': None, 'tags': [], 'required': True, 'run_id': None, 'updated_at': now,
        }
        cards.append(card)
    else:
        card['column'] = a.column
        for key, val in (('step', a.step), ('evidence', a.evidence), ('blocker', a.blocker),
                         ('owner', a.owner), ('model', a.model), ('title', a.title)):
            if val is not None:
                card[key] = val
        card['updated_at'] = now

    board['updated_at'] = now
    board['revision'] = int(board.get('revision') or 0) + 1
    BOARD.write_text(json.dumps(board, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"board: {a.id} -> {a.column}")


if __name__ == '__main__':
    main()
