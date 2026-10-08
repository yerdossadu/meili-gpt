import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import testing_gateway as gateway


class TestingGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        (self.state / 'credentials.json').write_text(json.dumps({'username': 'family', 'password': 'test-pass'}))
        patcher = patch.object(gateway, 'STATE', self.state)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(gateway.app)
        self.auth = ('family', 'test-pass')

    def test_all_content_requires_password(self):
        for path in ['/', '/api/lessons', '/forma/books/example/page.png', '/feedback']:
            self.assertEqual(self.client.get(path).status_code, 401)
            self.assertEqual(self.client.get(path, auth=('family', 'wrong')).status_code, 401)

    def test_admin_and_writes_are_blocked_even_with_password(self):
        for method, path in [('GET', '/manage'), ('GET', '/api/books'), ('POST', '/api/forma/pages'),
                             ('DELETE', '/api/forma/pages/book/1'), ('GET', '/docs'), ('GET', '/.local/settings.json')]:
            self.assertEqual(self.client.request(method, path, auth=self.auth).status_code, 403)

    def test_proxy_does_not_forward_credentials_and_feedback_link_is_present(self):
        reply = Mock(status_code=200, content=b'<html><body>Lesson</body></html>', headers={'content-type': 'text/html'})
        with patch.object(gateway.requests, 'request', return_value=reply) as send:
            result = self.client.get('/', auth=self.auth)
            self.assertIn('/feedback', result.text)
            self.assertNotIn('authorization', send.call_args.kwargs['headers'])
            self.assertEqual(result.headers['cache-control'], 'private, no-store')

    def test_feedback_persists_and_rejects_cross_origin(self):
        body = {'page': 'Workbook 3', 'message': 'Please explain this exercise.'}
        self.assertEqual(self.client.post('/feedback', auth=self.auth, data=body,
                         headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertFalse((self.state / 'feedback.jsonl').exists())
        response = self.client.post('/feedback', auth=self.auth, data=body, headers={'Origin': 'http://testserver'})
        self.assertEqual(response.status_code, 200)
        entry = json.loads((self.state / 'feedback.jsonl').read_text())
        self.assertEqual(entry['message'], body['message'])

    def test_upstream_unavailable_and_body_limit(self):
        with patch.object(gateway.requests, 'request', side_effect=gateway.requests.ConnectionError):
            self.assertEqual(self.client.get('/api/lessons', auth=self.auth).status_code, 502)
        self.assertEqual(self.client.post('/api/tutor', auth=self.auth, content='x'*64001).status_code, 413)


if __name__ == '__main__':
    unittest.main()
