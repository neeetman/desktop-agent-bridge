"""Attach only the coordinated execution helper; never reload global MCP."""
import json
import sys
from attachment_runtime import selection
from native_attach_loader import attach_selected
if __name__ == '__main__':
    try:
        selected = selection('codex', 'execution')
        if '--check' in sys.argv:
            print(json.dumps({'validated': True, 'attached': False, 'profileId': selected['profile']['id'], 'binding': selected['binding']}))
        else:
            print(json.dumps(attach_selected(selected, 'execution')))
    except Exception as error:
        print(json.dumps({'error': str(error), 'code': getattr(error, 'code', 'ATTACHMENT_ERROR'), 'dispatchNotStarted': True}))
        sys.exit(1)
