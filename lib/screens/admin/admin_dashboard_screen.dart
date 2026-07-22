import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class AdminDashboardScreen extends StatefulWidget {
  @override
  _AdminDashboardScreenState createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  Map<String, dynamic> stats = {};
  List<dynamic> recentLogs = [];
  bool isLoading = true;

  final String backendUrl = "https://labsync-backend-e2o8.onrender.com/api";

  @override
  void initState() {
    super.initState();
    _loadDashboard();
  }

  Future<void> _loadDashboard() async {
    setState(() => isLoading = true);

    try {
      // Load stats
      final statsResponse =
          await http.get(Uri.parse('$backendUrl/dashboard/stats'));
      if (statsResponse.statusCode == 200) {
        stats = json.decode(statsResponse.body);
      }

      // Load recent logs
      final logsResponse =
          await http.get(Uri.parse('$backendUrl/dashboard/recent-logs'));
      if (logsResponse.statusCode == 200) {
        recentLogs = json.decode(logsResponse.body)['logs'];
      }

      setState(() => isLoading = false);
    } catch (e) {
      setState(() => isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Admin Dashboard'),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh),
            onPressed: _loadDashboard,
          ),
        ],
      ),
      body: isLoading
          ? Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _loadDashboard,
              child: ListView(
                padding: EdgeInsets.all(16),
                children: [
                  // Stats Cards
                  Row(
                    children: [
                      _buildStatCard(
                        'Total Users',
                        stats['totalUsers']?.toString() ?? '0',
                        Icons.people,
                        Colors.blue,
                      ),
                      SizedBox(width: 16),
                      _buildStatCard(
                        'Active Rooms',
                        stats['activeRooms']?.toString() ?? '0',
                        Icons.meeting_room,
                        Colors.green,
                      ),
                    ],
                  ),
                  SizedBox(height: 16),
                  Row(
                    children: [
                      _buildStatCard(
                        'Today Access',
                        stats['todayAccess']?.toString() ?? '0',
                        Icons.access_time,
                        Colors.orange,
                      ),
                      SizedBox(width: 16),
                      _buildStatCard(
                        'Denied',
                        stats['deniedAccess']?.toString() ?? '0',
                        Icons.block,
                        Colors.red,
                      ),
                    ],
                  ),
                  SizedBox(height: 24),

                  // Recent Activity
                  Text(
                    'Recent Activity',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                  SizedBox(height: 8),
                  ...recentLogs
                      .map((log) => Card(
                            child: ListTile(
                              leading: Icon(
                                log['status'] == 'GRANTED'
                                    ? Icons.check_circle
                                    : Icons.cancel,
                                color: log['status'] == 'GRANTED'
                                    ? Colors.green
                                    : Colors.red,
                              ),
                              title: Text(log['userName'] ?? 'Unknown'),
                              subtitle: Text(
                                  '${log['action']} - ${log['timestamp']}'),
                              trailing: Text(log['authMethod'] ?? ''),
                            ),
                          ))
                      .toList(),
                ],
              ),
            ),
    );
  }

  Widget _buildStatCard(
      String title, String value, IconData icon, Color color) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Column(
            children: [
              Icon(icon, size: 40, color: color),
              SizedBox(height: 8),
              Text(
                value,
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
              ),
              Text(title, style: TextStyle(color: Colors.grey)),
            ],
          ),
        ),
      ),
    );
  }
}
