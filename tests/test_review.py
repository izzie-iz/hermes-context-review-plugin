"""Contract tests. All review data uses isolated scratch homes, never real sessions."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_engine():
    spec = importlib.util.spec_from_file_location('context_review_test', ROOT / '__init__.py', submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.ContextReviewEngine


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.tmp.cleanup)

    def engine(self, home=None, session='test-session', window=1000000):
        engine = load_engine()(home=Path(home or self.tmp.name))
        engine.update_model('test', window)
        engine.on_session_start(session)
        return engine

    def history(self):
        return [
            {'role': 'system', 'content': 'System rules stay unchanged.'},
            {'role': 'user', 'content': 'Put the dashboard in the main repo.'},
            {'role': 'assistant', 'content': 'We could instead use a separate repo, but this is a proposal.'},
            {'role': 'user', 'content': 'Review the context now.'},
            {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'begin', 'type': 'function', 'function': {'name': 'context_review', 'arguments': '{"action":"start"}'}}]},
        ]

    def call(self, engine, action, messages=None, **args):
        return json.loads(engine.handle_tool_call('context_review', {'action': action, **args}, messages=messages or self.history()))

    def test_dynamic_question_requires_real_source_and_waits_for_answer(self):
        engine = self.engine()
        begun = self.call(engine, 'start')
        self.assertEqual(begun['phase'], 'reviewing')
        self.assertEqual(begun['snapshot_messages'], 2)
        bad = self.call(engine, 'ask', question='Which repo should I keep?', why='It changes the artifact location.', sources=[{'index': 0, 'quote': 'invented text'}])
        self.assertIn('error', bad)
        good = self.call(engine, 'ask', question='Should I retain your main-repo decision?', why='The separate repo was only an unapproved suggestion.', sources=[{'index': 0, 'quote': 'main repo'}])
        self.assertEqual(good['question'], 'Should I retain your main-repo decision?')
        duplicate = self.call(engine, 'ask', question='Should it move?', why='Location.', sources=[{'index': 0, 'quote': 'main repo'}])
        self.assertIn('error', duplicate)
        note = engine.before_turn('Yes, keep the main repo.', turn_id='answer1')
        self.assertIn('one', note['context'].lower())
        state = self.call(engine, 'status')
        self.assertEqual(state['answers'][0]['answer'], 'Yes, keep the main repo.')
        followup = self.call(engine, 'ask', question='Does that include the replacement dashboard?', why='Your answer fixes the repository but not the replacement scope.', followup_to=good['question_id'])
        self.assertIn('question_id', followup)
        self.assertIn('error', self.call(engine, 'ask', question='Where? And when?', why='Two questions.', followup_to=good['question_id']))

    def proposal(self):
        return {'objective': 'Keep the dashboard working.', 'active_work': ['Continue dashboard maintenance.'], 'decisions': ['USER approved main repo; separate repo remains an assistant proposal [source 0,1].'], 'constraints': ['Do not change other projects.'], 'artifacts': ['Main repo dashboard; exact path not supplied.'], 'open_questions': [], 'next_actions': ['Inspect the dashboard.'], 'remove_from_active': ['Repeated explanations, not source history.']}

    def test_only_version_bound_human_approval_allows_compaction(self):
        engine = self.engine()
        original = self.history()
        self.assertEqual(engine.compress(original, force=True), original)
        self.call(engine, 'start')
        proposed = self.call(engine, 'propose', handoff=self.proposal())
        self.assertIn('approval_phrase', proposed)
        self.assertFalse(engine.should_compress())
        engine.before_turn('yes')
        self.assertFalse(engine.should_compress(), 'Generic yes is not version-bound cleanup permission')
        self.assertIn('error', self.call(engine, 'approve', version=proposed['version']))
        engine.before_turn(proposed['approval_phrase'])
        self.assertTrue(engine.should_compress())
        tail = original[3:] + [{'role': 'tool', 'tool_call_id': 'begin', 'content': 'review started'}, {'role': 'assistant', 'content': proposed['preview']}, {'role': 'user', 'content': proposed['approval_phrase']}]
        live = original[:3] + tail
        before = json.loads(json.dumps(live))
        compacted = engine.compress(live)
        self.assertEqual(live, before, 'Compression must not mutate caller input before host commit')
        self.assertEqual(compacted[0], original[0])
        self.assertIn('main repo', compacted[1]['content'])
        self.assertEqual(compacted[3:], tail, 'Every post-snapshot message and tool pair survives verbatim')
        self.assertEqual(self.call(engine, 'status')['phase'], 'approved', 'Not applied until host commit callback')
        engine.on_session_start('test-session', boundary_reason='compression', old_session_id='test-session')
        self.assertEqual(self.call(engine, 'status')['phase'], 'applied')
        self.assertFalse(engine.should_compress())

    def test_changed_snapshot_or_revised_proposal_invalidates_approval(self):
        engine = self.engine()
        self.call(engine, 'start')
        first = self.call(engine, 'propose', handoff=self.proposal())
        revised = self.proposal()
        revised['objective'] = 'Keep only the existing dashboard.'
        second = self.call(engine, 'propose', handoff=revised)
        self.assertNotEqual(first['version'], second['version'])
        engine.before_turn(first['approval_phrase'])
        self.assertFalse(engine.should_compress())
        engine.before_turn(second['approval_phrase'])
        changed = self.history()
        changed[1] = {'role': 'user', 'content': 'Altered historical instruction.'}
        self.assertEqual(engine.compress(changed), changed)
        self.assertFalse(engine.should_compress())

    def test_profiles_sessions_and_restart_are_isolated(self):
        one = self.engine(home=Path(self.tmp.name) / 'one', session='same-id')
        two = self.engine(home=Path(self.tmp.name) / 'two', session='same-id')
        self.call(one, 'start')
        question = self.call(one, 'ask', question='Should I retain the main repo?', why='Location affects the handoff.', sources=[{'index': 0, 'quote': 'main repo'}])
        restarted = self.engine(home=Path(self.tmp.name) / 'one', session='same-id')
        self.assertEqual(self.call(restarted, 'status')['pending_question']['question_id'], question['question_id'])
        self.assertEqual(self.call(two, 'status')['phase'], 'idle')
        other_session = self.engine(home=Path(self.tmp.name) / 'one', session='different')
        self.assertEqual(self.call(other_session, 'status')['phase'], 'idle')
        restarted.before_turn('Retain it.', turn_id='unique')
        self.assertEqual(self.call(one, 'status')['answers'][0]['answer'], 'Retain it.')
        self.call(one, 'pause')
        self.assertEqual(self.call(one, 'status')['phase'], 'paused')
        self.assertIsNone(one.before_turn('Work on another task.'))
        self.call(one, 'resume')
        self.assertEqual(self.call(one, 'status')['phase'], 'reviewing')
        self.call(one, 'dismiss')
        one.update_from_response({'prompt_tokens': 400000})
        self.assertIsNone(one.before_turn('Do not interrupt.'))

    def test_smaller_models_get_earlier_reminders_without_auto_cleanup(self):
        engine = self.engine(window=200000)
        engine.update_from_response({'prompt_tokens': 120000})
        self.assertIn('120,000', engine.before_turn('continue')['context'])
        self.assertFalse(engine.should_compress(199000))
        self.assertEqual(engine.compress(self.history(), current_tokens=199000, force=True), self.history())

    def test_plugin_registers_hook_and_engine_and_tool_schema(self):
        module = __import__('sys').modules[load_engine().__module__]
        class Context:
            def __init__(self):
                self.hooks = {}
                self.engine = None
            def register_context_engine(self, engine):
                self.engine = engine
            def register_hook(self, name, callback):
                self.hooks[name] = callback
            def register_tool(self, **kwargs):
                self.tool = kwargs
        context = Context()
        module.register(context)
        self.assertIn('pre_llm_call', context.hooks)
        self.assertEqual(context.engine.name, 'context-review')
        self.assertEqual(context.engine.get_tool_schemas()[0]['name'], 'context_review')

    def test_host_loader_and_session_store_keep_original_history(self):
        from unittest.mock import patch
        home = Path(self.tmp.name) / 'host'
        (home / 'plugins').mkdir(parents=True)
        (home / 'plugins' / 'context-review').symlink_to(ROOT, target_is_directory=True)
        from plugins.context_engine import load_context_engine
        from hermes_cli.plugins_loader import _plugin_home_scope
        with _plugin_home_scope(home):
            engine = load_context_engine('context-review')
        self.assertIsNotNone(engine)
        engine.home = home
        engine.update_model('test', 1000000)
        engine.on_session_start('persist-test')
        history = self.history()
        history[1]['content'] += '\nRepeated details. ' * 1000
        self.call(engine, 'start', messages=history)
        proposal = self.call(engine, 'propose', messages=history, handoff=self.proposal())
        engine.before_turn(proposal['approval_phrase'])
        compacted = engine.compress(history)
        from hermes_state import SessionDB
        db = SessionDB(db_path=home / 'test-state.db')
        self.addCleanup(db.close)
        db.create_session(session_id='persist-test', source='cli')
        for msg in history[:4]:
            db.append_message('persist-test', role=msg['role'], content=msg.get('content'))
        db.archive_and_compact('persist-test', compacted)
        active = db.get_messages('persist-test')
        self.assertTrue(any('Reviewed context handoff' in str(m.get('content')) for m in active))
        with __import__('contextlib').closing(__import__('sqlite3').connect(home / 'test-state.db')) as conn:
            found = conn.execute("SELECT COUNT(*) FROM messages WHERE content LIKE '%Put the dashboard%'").fetchone()[0]
        self.assertGreaterEqual(found, 1, 'Compaction must keep the original evidence in the session DB')

    def test_safety_guard_refuses_native_bypass_configuration(self):
        module = __import__('sys').modules[load_engine().__module__]
        self.assertIsNone(module.runtime_config_problem({'context': {'engine': 'context-review'}, 'model': {'api_mode': 'codex_responses'}, 'compression': {'codex_responses_native': False}}))
        self.assertIn('app-server', module.runtime_config_problem({'context': {'engine': 'context-review'}, 'model': {'api_mode': 'codex_app_server'}}))
        self.assertIn('native', module.runtime_config_problem({'context': {'engine': 'context-review'}, 'compression': {'codex_responses_native': True}}))
        with self.assertRaisesRegex(ValueError, 'app-server'):
            self.engine().update_model('test', 1000000, api_mode='codex_app_server')

    def test_unanswered_question_blocks_proposal_and_tool_cannot_approve(self):
        engine = self.engine()
        self.call(engine, 'start')
        self.call(engine, 'ask', question='Should I retain the main repo?', why='It changes location.', sources=[{'index': 0, 'quote': 'main repo'}])
        self.assertIn('error', self.call(engine, 'propose', handoff=self.proposal()))
        self.assertIn('error', self.call(engine, 'approve'))
        self.assertFalse(engine.should_compress())
        self.assertNotIn('snapshot', self.call(engine, 'status'))

    def test_z_real_agent_compression_commit_and_lifecycle(self):
        from hermes_cli.plugins_loader import _plugin_home_scope
        from hermes_state import SessionDB
        from run_agent import AIAgent
        home = Path(self.tmp.name) / 'agent-host'
        (home / 'plugins').mkdir(parents=True)
        (home / 'plugins' / 'context-review').symlink_to(ROOT, target_is_directory=True)
        (home / 'config.yaml').write_text('context:\n  engine: context-review\nmodel:\n  context_length: 1000000\nplugins:\n  enabled: [context-review]\ncompression:\n  enabled: true\n  codex_responses_native: false\n')
        db = SessionDB(db_path=home / 'state.db')
        self.addCleanup(db.close)
        db.create_session(session_id='agent-host-test', source='cli')
        with _plugin_home_scope(home):
            from hermes_cli.config import load_config_readonly
            self.assertEqual(load_config_readonly().get('context', {}).get('engine'), 'context-review', 'Fixture config must reach the real agent config reader')
            from agent.safe_worker_policy import safe_worker_enabled
            self.assertFalse(safe_worker_enabled(), 'Safe worker disables external context engines')
            agent = AIAgent(model='test-context-review', provider='openai', api_mode='chat_completions', api_key='not-a-real-key', base_url='http://127.0.0.1:9/v1', enabled_toolsets=['context_engine'], skip_context_files=True, skip_memory=True, skip_background_review=True, quiet_mode=True, session_id='agent-host-test', session_db=db)
            self.assertEqual(agent.context_compressor.name, 'context-review')
            self.assertIn('context_review', agent._context_engine_tool_names)
            history = self.history()
            history[1]['content'] += '\nOld repeated output.' * 5000
            history = history[:4]
            engine = agent.context_compressor
            self.call(engine, 'start', messages=history)
            proposal = self.call(engine, 'propose', messages=history, handoff=self.proposal())
            engine.before_turn(proposal['approval_phrase'])
            for msg in history:
                db.append_message('agent-host-test', role=msg['role'], content=msg.get('content'))
            from agent.conversation_compression import compress_context
            result, prompt = compress_context(agent, history, history[0]['content'], force=True)
            self.assertTrue(any('Reviewed context handoff' in str(m.get('content')) for m in result))
            self.assertEqual(self.call(engine, 'status')['phase'], 'applied')
            self.assertFalse(engine.should_compress())

    def test_hook_blocks_preexisting_agent_until_native_engine_initializes(self):
        module = __import__('sys').modules[load_engine().__module__]
        from hermes_cli.plugins_loader import _plugin_home_scope
        home = Path(self.tmp.name) / 'hook-profile'
        home.mkdir()
        (home / 'config.yaml').write_text('context:\n  engine: context-review\ncompression:\n  codex_responses_native: false\n')
        with _plugin_home_scope(home):
            blocked = module.before_turn_hook(session_id='old-agent', user_message='continue')
            self.assertEqual(blocked['action'], 'block')
            self.engine(home=home, session='old-agent')
            self.assertIsNone(module.before_turn_hook(session_id='old-agent', user_message='continue'))

    def test_registered_tool_is_visible_through_real_tool_describe(self):
        from hermes_cli.plugin_dev import _doctor_runtime
        import model_tools
        with _doctor_runtime(ROOT) as host:
            self.assertIn('context_review', host.registered_tools)
            described = json.loads(model_tools.handle_function_call('tool_describe', {'names': ['context_review']}, enabled_toolsets=['context_engine'], session_id='bridge-probe'))
            self.assertIn('context_review', described.get('tools', {}), described)
            status = json.loads(model_tools.handle_function_call('context_review', {'action': 'status'}, enabled_toolsets=['context_engine'], session_id='bridge-probe'))
            self.assertEqual(status['phase'], 'idle')
            self.assertFalse(status.get('engine_initialized', False))
            missing = json.loads(model_tools.handle_function_call('context_review', {'action': 'start'}, enabled_toolsets=['context_engine']))
            self.assertIn('error', missing)

    def test_registry_review_reads_only_current_sessions_active_history(self):
        from hermes_cli.plugin_dev import _doctor_runtime
        from hermes_state import SessionDB
        import model_tools
        with _doctor_runtime(ROOT) as host:
            home = host.manager.home_path
            import yaml
            config_path = home / 'config.yaml'
            config = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
            config['context'] = {'engine': 'context-review'}
            config_path.write_text(yaml.safe_dump(config))
            db = SessionDB(db_path=home / 'state.db')
            try:
                db.create_session(session_id='bound-session', source='cli')
                db.create_session(session_id='other-session', source='cli')
                history = self.history()[:4]
                for m in history:
                    db.append_message('bound-session', role=m['role'], content=m['content'])
                db.append_message('other-session', role='user', content='PRIVATE OTHER SESSION')
                engine = self.engine(home=home, session='bound-session')
                begin = json.loads(model_tools.handle_function_call('context_review', {'action': 'start'}, enabled_toolsets=['context_engine'], session_id='bound-session'))
                self.assertEqual(begin['snapshot_messages'], 2, begin)
                inspect = json.loads(model_tools.handle_function_call('context_review', {'action': 'inspect'}, enabled_toolsets=['context_engine'], session_id='bound-session'))
                self.assertNotIn('PRIVATE OTHER SESSION', json.dumps(inspect))
                proposal = self.call(engine, 'propose', messages=db.get_messages('bound-session'), handoff=self.proposal())
                engine.before_turn(proposal['approval_phrase'])
                stored = db.get_messages('bound-session')
                self.assertEqual(engine._fingerprint(history[1]), engine._fingerprint(stored[1]), {'live': history[1], 'stored': stored[1]})
                result = engine.compress(history)
                self.assertIn('Reviewed context handoff', result[1]['content'])
                self.assertEqual(len(db.get_messages('bound-session')), 4, 'Tool must not rewrite original transcript storage')
            finally:
                db.close()

    def test_live_gateway_version_admits_plugin_and_registers_tool(self):
        from unittest.mock import patch
        from hermes_cli.plugin_dev import _doctor_runtime
        with patch('hermes_cli.plugins_manifest.running_hermes_version', return_value='0.22.5'):
            with _doctor_runtime(ROOT) as host:
                self.assertIn('context_review', host.registered_tools)
                self.assertIn('pre_llm_call', host.registered_hooks)

    def test_reminder_uses_active_prompt_not_cumulative_total(self):
        engine = self.engine()
        engine.update_from_response({'prompt_tokens': 1000, 'total_tokens': 900000})
        self.assertIsNone(engine.before_turn('hello'))
        engine.update_from_response({'prompt_tokens': 250000, 'total_tokens': 900000})
        note = engine.before_turn('continue')
        self.assertIn('250,000', note['context'])
        self.assertIn('review', note['context'].lower())
        self.assertIsNone(engine.before_turn('continue'))
        engine.update_from_response({'prompt_tokens': 300000})
        self.assertIn('300,000', engine.before_turn('continue')['context'])


if __name__ == '__main__':
    unittest.main()
