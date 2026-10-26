#!/usr/bin/env python3
"""Parse a bounded Gmail Atom feed. No network, credentials, or external XML entities."""
import json
import re
import sys
import xml.etree.ElementTree as ET

MAX_BYTES = 256 * 1024


def parse(raw):
    if len(raw) > MAX_BYTES or re.search(br'<!\s*(?:DOCTYPE|ENTITY)', raw, re.I):
        raise ValueError('invalid-feed')
    root = ET.fromstring(raw)
    if root.tag not in ('feed', '{http://purl.org/atom/ns#}feed', '{http://www.w3.org/2005/Atom}feed'):
        raise ValueError('invalid-feed')
    ns = root.tag[:-4]
    def text(node, name, limit):
        return (node.findtext(ns + name) or '')[:limit]
    title = text(root, 'title', 1024)
    identity = re.search(r'\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b', title, re.I)
    count = text(root, 'fullcount', 12)
    if not identity or not count.isdecimal():
        raise ValueError('identity-unverified')
    emails = []
    for entry in root.findall(ns + 'entry')[:200]:
        thread_id = text(entry, 'id', 512).rsplit(':', 1)[-1]
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', thread_id):
            raise ValueError('invalid-feed')
        author = entry.find(ns + 'author')
        emails.append(dict(threadId=thread_id, subject=text(entry, 'title', 1024),
                           snippet=text(entry, 'summary', 2048),
                           **{'from': text(author, 'name', 512) if author is not None else ''},
                           date=text(entry, 'issued', 128) or text(entry, 'modified', 128), unread=True))
    return dict(account=identity[1].lower(), unread=min(int(count), 1000000), emails=emails)


if __name__ == '__main__':
    try:
        print(json.dumps(parse(sys.stdin.buffer.read(MAX_BYTES + 1)), ensure_ascii=True))
    except (ValueError, ET.ParseError, UnicodeError):
        sys.exit(1)
